import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  CATALOG_FILE_SUFFIX,
  CatalogSymbolOutlineSettings,
  CatalogTabSettings,
  CatalogIssue,
  CatalogProject,
  isCatalogFileName,
  parseProjectCatalogText,
  ProjectCatalog,
} from './catalogModel';
import { createCatalogTemplateText } from './catalogTemplate';
import {
  createCatalogProjectInsertion,
  createCatalogSymbolOutlineSettingsEdits,
  createCatalogTabSettingsEdits,
  NewCatalogProject,
} from './catalogTextEdit';
import { chooseCatalogToRestore, shouldAutoActivateCatalog } from './catalogActivation';
import { classifyProjectContext } from './projectContext';

const LAST_CATALOG_KEY = 'projectManager.projectCatalog.lastUri';
const WORKSPACE_CATALOG_KEY = 'projectManager.projectCatalog.workspaceUri';
const RESTORE_ENABLED_KEY = 'projectManager.projectCatalog.restoreEnabled';
const PROJECT_BINDINGS_KEY = 'projectManager.projectCatalog.projectBindings';

export type CatalogTabSettingKey = keyof CatalogTabSettings;

export interface ResolvedCatalogProject extends CatalogProject {
  readonly uri: vscode.Uri | undefined;
  readonly available: boolean;
  readonly runtimeIssue?: string;
}

export interface ActiveProjectCatalog {
  readonly uri: vscode.Uri;
  readonly catalog: ProjectCatalog;
  readonly projects: readonly ResolvedCatalogProject[];
}

export type CurrentProjectContext =
  | { readonly kind: 'member'; readonly project: ResolvedCatalogProject }
  | { readonly kind: 'external' }
  | { readonly kind: 'noWorkspace' };

interface SelectedProjectResource {
  readonly uri: vscode.Uri;
  readonly type: 'folder' | 'workspace';
  readonly suggestedAlias: string;
}

export class ProjectCatalogService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ActiveProjectCatalog | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private activeCatalog: ActiveProjectCatalog | undefined;
  private ignoredCatalogUri: string | undefined;
  private restoreIssue: string | undefined;

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel,
  ) {
    this.disposables.push(
      this.changeEmitter,
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (isCatalogFileName(document.uri.path) && this.canAutoActivateCatalog(document.uri)) {
          void this.load(document.uri, document.getText(), true);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.toString() === this.ignoredCatalogUri) {
          this.ignoredCatalogUri = undefined;
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.activeCatalog?.uri.toString() === event.document.uri.toString()) {
          this.scheduleReload(event.document);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.activeCatalog?.uri.toString() === document.uri.toString()) {
          void this.load(document.uri, document.getText(), true);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor !== undefined
          && isCatalogFileName(editor.document.uri.path)
          && this.canAutoActivateCatalog(editor.document.uri)) {
          void this.load(editor.document.uri, editor.document.getText(), true);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.changeEmitter.fire(this.activeCatalog);
      }),
    );
  }

  public get current(): ActiveProjectCatalog | undefined {
    return this.activeCatalog;
  }

  public get lastRestoreIssue(): string | undefined {
    return this.restoreIssue;
  }

  public get projectContext(): CurrentProjectContext {
    const catalog = this.activeCatalog;
    const classification = classifyProjectContext(
      this.hasCurrentWorkspace(),
      this.getCurrentProjectKey(),
      catalog?.projects.flatMap((project) => project.available && project.uri !== undefined
        ? [{ projectIndex: project.index, key: this.uriComparisonKey(project.uri) }]
        : []) ?? [],
    );
    if (classification.kind === 'noWorkspace') {
      return { kind: 'noWorkspace' };
    }
    if (classification.kind === 'external' || catalog === undefined) {
      return { kind: 'external' };
    }
    const project = catalog.projects.find((candidate) => candidate.index === classification.projectIndex);
    return project === undefined ? { kind: 'external' } : { kind: 'member', project };
  }

  public get currentProjectTabSettings(): CatalogTabSettings | undefined {
    return this.projectContext.kind === 'member'
      ? this.activeCatalog?.catalog.features.tabs
      : undefined;
  }

  public get currentProjectSymbolOutlineSettings(): CatalogSymbolOutlineSettings | undefined {
    return this.projectContext.kind === 'member'
      ? this.activeCatalog?.catalog.features.symbolOutline
      : undefined;
  }

  public async initialize(): Promise<void> {
    if (!this.context.workspaceState.get<boolean>(RESTORE_ENABLED_KEY, true)) {
      return;
    }
    const bindings = this.context.globalState.get<Record<string, string>>(PROJECT_BINDINGS_KEY, {});
    const boundCatalog = this.getCurrentProjectKey() === undefined
      ? undefined
      : bindings[this.getCurrentProjectKey() ?? ''];
    const workspaceCatalogUri = boundCatalog
      ?? this.context.workspaceState.get<string>(WORKSPACE_CATALOG_KEY);
    const lastCatalogUri = this.context.globalState.get<string>(LAST_CATALOG_KEY);
    const openCatalogDocuments = vscode.workspace.textDocuments.filter((document) => isCatalogFileName(document.uri.path));
    const activeEditorUri = vscode.window.activeTextEditor !== undefined
      && isCatalogFileName(vscode.window.activeTextEditor.document.uri.path)
      ? vscode.window.activeTextEditor.document.uri.toString()
      : undefined;
    const selectedUri = chooseCatalogToRestore(
      workspaceCatalogUri,
      lastCatalogUri,
      this.hasCurrentWorkspace(),
      activeEditorUri,
      openCatalogDocuments.map((document) => document.uri.toString()),
    );
    if (selectedUri !== undefined) {
      const openDocument = openCatalogDocuments.find((document) => document.uri.toString() === selectedUri);
      await this.load(
        vscode.Uri.parse(selectedUri),
        openDocument?.getText(),
        selectedUri !== workspaceCatalogUri && selectedUri !== lastCatalogUri,
      );
    }
  }

  public async selectCatalogFile(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { '项目管家集合文件': ['project-butler.json'], JSON: ['json'] },
      openLabel: '打开项目集合',
      title: '选择 *.project-butler.json 项目集合文件',
    });
    const uri = selected?.[0];
    if (uri === undefined) {
      return;
    }

    if (!isCatalogFileName(uri.path)) {
      await vscode.window.showErrorMessage('请选择以 .project-butler.json 结尾的项目集合文件。');
      return;
    }

    this.ignoredCatalogUri = undefined;

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    if (!(await document.save())) {
      await vscode.window.showErrorMessage('项目集合模板已经创建，但内容保存失败，请手动保存后继续。');
      return;
    }
    await this.load(uri, document.getText(), true);
  }

  public async createCatalogTemplate(): Promise<void> {
    const baseUri = this.activeCatalog === undefined
      ? vscode.workspace.workspaceFolders?.[0]?.uri
      : vscode.Uri.joinPath(this.activeCatalog.uri, '..');
    const saveOptions: vscode.SaveDialogOptions = {
      filters: { '项目管家集合文件': ['project-butler.json'] },
      saveLabel: '创建项目集合模板',
      title: '创建带使用说明的项目集合模板',
      ...(baseUri === undefined
        ? {}
        : { defaultUri: vscode.Uri.joinPath(baseUri, `projects${CATALOG_FILE_SUFFIX}`) }),
    };
    const selectedUri = await vscode.window.showSaveDialog(saveOptions);
    if (selectedUri === undefined) {
      return;
    }

    const uri = isCatalogFileName(selectedUri.path)
      ? selectedUri
      : selectedUri.with({ path: `${selectedUri.path}${CATALOG_FILE_SUFFIX}` });
    try {
      await vscode.workspace.fs.stat(uri);
      await vscode.window.showErrorMessage(`文件已经存在，项目管家不会覆盖它：${uri.fsPath}`);
      return;
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') {
        const message = `无法确认模板文件是否存在：${error instanceof Error ? error.message : String(error)}`;
        this.output.appendLine(message);
        await vscode.window.showErrorMessage(message);
        return;
      }
    }

    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
    edit.insert(uri, new vscode.Position(0, 0), createCatalogTemplateText());
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      await vscode.window.showErrorMessage('项目集合模板创建失败，未修改已有文件。');
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    this.ignoredCatalogUri = undefined;
    await this.load(uri, document.getText(), true);
    await vscode.window.showInformationMessage('项目集合模板已创建，可使用“添加项目”按钮继续。');
  }

  public async addProjectToCatalog(): Promise<void> {
    if (!(await this.ensureActiveCatalog())) {
      return;
    }
    const activeCatalog = this.activeCatalog;
    if (activeCatalog === undefined) {
      return;
    }

    const projectResource = await this.selectProjectResource();
    if (projectResource === undefined) {
      return;
    }
    const relativePath = this.createPortableRelativePath(activeCatalog.uri, projectResource.uri);
    if (relativePath === undefined) {
      await vscode.window.showErrorMessage('所选项目与集合文件不在同一文件系统或 Windows 盘符，无法生成便携相对路径。');
      return;
    }

    if (this.hasDuplicateProjectUri(activeCatalog, projectResource.uri)) {
      await vscode.window.showWarningMessage('所选项目已经存在于当前项目集合中。');
      return;
    }

    const alias = await vscode.window.showInputBox({
      title: '添加项目：设置别名',
      prompt: '别名会作为项目树中的主标题。',
      value: projectResource.suggestedAlias,
      validateInput: (value) => this.validateAlias(value, activeCatalog),
    });
    if (alias === undefined) {
      return;
    }

    const description = await vscode.window.showInputBox({
      title: `添加“${alias.trim()}”：项目说明`,
      prompt: '可选，留空表示不写入 description。',
      placeHolder: '例如：前端管理系统',
    });
    if (description === undefined) {
      return;
    }

    const tagsInput = await vscode.window.showInputBox({
      title: `添加“${alias.trim()}”：项目标签`,
      prompt: '可选，多个标签使用英文逗号分隔。',
      placeHolder: '例如：前端, 日常开发',
    });
    if (tagsInput === undefined) {
      return;
    }

    const tags = [...new Set(tagsInput
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0))];
    const project: NewCatalogProject = {
      alias: alias.trim(),
      path: relativePath,
      type: projectResource.type,
      ...(description.trim().length === 0 ? {} : { description: description.trim() }),
      ...(tags.length === 0 ? {} : { tags }),
    };
    const confirmed = await vscode.window.showInformationMessage(
      `确认将“${project.alias}”添加到项目集合吗？`,
      {
        modal: true,
        detail: JSON.stringify(project, undefined, 2),
      },
      '确认添加',
    );
    if (confirmed !== '确认添加') {
      return;
    }

    await this.appendProject(activeCatalog.uri, project);
  }

  public async showSource(): Promise<void> {
    if (this.activeCatalog === undefined) {
      await this.selectCatalogFile();
      return;
    }

    const document = await vscode.workspace.openTextDocument(this.activeCatalog.uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  public async closeCatalog(): Promise<void> {
    const catalog = this.activeCatalog;
    if (catalog === undefined) {
      return;
    }
    this.ignoredCatalogUri = vscode.workspace.textDocuments.some(
      (document) => document.uri.toString() === catalog.uri.toString(),
    ) ? catalog.uri.toString() : undefined;
    this.activeCatalog = undefined;
    this.restoreIssue = undefined;
    this.fileWatcher?.dispose();
    this.fileWatcher = undefined;
    await this.context.workspaceState.update(RESTORE_ENABLED_KEY, false);
    this.changeEmitter.fire(undefined);
    this.output.appendLine(`已关闭当前项目集合：${catalog.uri.toString()}`);
  }

  public async configureTabSetting(key: CatalogTabSettingKey): Promise<void> {
    if (!(await this.ensureActiveCatalog()) || this.activeCatalog === undefined) {
      return;
    }
    const catalog = this.activeCatalog;
    if (catalog.catalog.compatibility === 'unsupported' || catalog.catalog.compatibility === 'invalid') {
      await vscode.window.showErrorMessage('当前集合格式不受支持，无法修改标签配置。');
      return;
    }

    const current = catalog.catalog.features.tabs;
    if (key !== 'autoOrganize') {
      return;
    }
    const selected = await vscode.window.showQuickPick([
      { label: '开启自动移至末尾', description: '工作区外和非项目标签稳定置后', value: true },
      { label: '关闭自动移至末尾', description: '不自动移动标签，仍可使用手动命令', value: false },
    ], { title: '标签页设置：自动整理' });
    if (selected === undefined) {
      return;
    }
    const next: CatalogTabSettings = { autoOrganize: selected.value };
    if (isSameTabSettings(current, next)) {
      return;
    }

    const upgrading = catalog.catalog.schemaVersion !== 3;
    const confirmed = await vscode.window.showInformationMessage(
      upgrading ? `保存简化标签配置需要将当前集合从 v${catalog.catalog.schemaVersion ?? '?'} 升级到 v3，是否继续？` : '确认更新当前集合的自动整理开关吗？',
      { modal: true, detail: JSON.stringify({ schemaVersion: 3, features: { tabs: next } }, undefined, 2) },
      upgrading ? '升级并保存' : '确认保存',
    );
    if (confirmed !== (upgrading ? '升级并保存' : '确认保存')) {
      return;
    }
    await this.writeTabSettings(catalog.uri, next);
  }

  public async configureOutlineMode(): Promise<void> {
    if (!(await this.ensureActiveCatalog()) || this.activeCatalog === undefined) {
      return;
    }
    const catalog = this.activeCatalog;
    if (catalog.catalog.compatibility === 'unsupported' || catalog.catalog.compatibility === 'invalid') {
      await vscode.window.showErrorMessage('当前集合格式不受支持，无法修改函数大纲配置。');
      return;
    }

    const current = catalog.catalog.features.symbolOutline.mode;
    const selected = await vscode.window.showQuickPick([
      { label: '仅使用增强大纲', description: current === 'enhanced' ? '当前集合值' : '', value: 'enhanced' as const },
      { label: '同时使用两个大纲', description: current === 'both' ? '当前集合值' : '', value: 'both' as const },
      { label: '仅使用 VS Code 原生大纲', description: current === 'native' ? '当前集合值' : '', value: 'native' as const },
    ], {
      title: '项目集合：函数大纲模式',
      placeHolder: '保存到当前 *.project-butler.json，可随集合文件复制',
    });
    if (selected === undefined) {
      return;
    }
    if (selected.value === current) {
      await vscode.window.showInformationMessage(`当前集合已经设置为“${formatOutlineMode(selected.value)}”。`);
      return;
    }

    const upgrading = catalog.catalog.schemaVersion !== 3;
    const confirmed = await vscode.window.showInformationMessage(
      upgrading
        ? `保存函数大纲配置需要将当前集合从 v${catalog.catalog.schemaVersion ?? '?'} 升级到 v3，是否继续？`
        : `确认把当前集合的函数大纲模式改为“${formatOutlineMode(selected.value)}”吗？`,
      { modal: true, detail: JSON.stringify({ schemaVersion: 3, features: { symbolOutline: { mode: selected.value } } }, undefined, 2) },
      upgrading ? '升级并保存' : '确认保存',
    );
    if (confirmed !== (upgrading ? '升级并保存' : '确认保存')) {
      return;
    }
    await this.writeOutlineSettings(catalog.uri, { mode: selected.value });
  }

  public async updateCurrentOutlineMode(mode: 'native' | 'enhanced' | 'both'): Promise<boolean> {
    if (this.projectContext.kind !== 'member' || this.activeCatalog === undefined) {
      return false;
    }
    const catalog = this.activeCatalog;
    if (catalog.catalog.compatibility === 'unsupported' || catalog.catalog.compatibility === 'invalid') {
      await vscode.window.showErrorMessage('当前集合格式不受支持，无法修改函数大纲配置。');
      return true;
    }
    if (catalog.catalog.features.symbolOutline.mode === mode) {
      return true;
    }
    if (catalog.catalog.schemaVersion !== 3) {
      const confirmed = await vscode.window.showInformationMessage(
        `保存函数大纲配置需要将当前集合从 v${catalog.catalog.schemaVersion ?? '?'} 升级到 v3，是否继续？`,
        { modal: true },
        '升级并保存',
      );
      if (confirmed !== '升级并保存') {
        return true;
      }
    }
    await this.writeOutlineSettings(catalog.uri, { mode });
    return true;
  }

  public async refresh(): Promise<void> {
    if (this.activeCatalog !== undefined) {
      await this.load(this.activeCatalog.uri, undefined, true);
    }
  }

  public async openProject(project: ResolvedCatalogProject, mode?: 'newWindow' | 'currentWindow'): Promise<void> {
    if (!project.available || project.uri === undefined) {
      await vscode.window.showErrorMessage(project.runtimeIssue ?? project.issues[0]?.message ?? '该项目配置无效，无法打开。');
      return;
    }

    const configuredMode = vscode.workspace.getConfiguration('projectManager.projectCatalog')
      .get<'prompt' | 'newWindow' | 'currentWindow'>('openMode', 'prompt');
    let openMode: 'newWindow' | 'currentWindow' | undefined = mode;
    if (openMode === undefined && configuredMode === 'prompt') {
      const selected = await vscode.window.showQuickPick([
        {
          label: '在新窗口打开',
          description: '保留当前项目集合窗口',
          mode: 'newWindow' as const,
        },
        {
          label: '在当前窗口打开',
          description: '当前窗口将切换到所选项目',
          mode: 'currentWindow' as const,
        },
      ], {
        title: `打开“${project.alias}”`,
        placeHolder: '请选择打开项目的窗口方式',
      });
      if (selected === undefined) {
        return;
      }
      openMode = selected.mode;
    } else if (openMode === undefined) {
      openMode = configuredMode === 'currentWindow' ? 'currentWindow' : 'newWindow';
    }

    if (this.activeCatalog !== undefined) {
      await this.rememberProjectBinding(project.uri, this.activeCatalog.uri);
    }
    await vscode.commands.executeCommand('vscode.openFolder', project.uri, {
      forceNewWindow: openMode === 'newWindow',
      forceReuseWindow: openMode === 'currentWindow',
    });
  }

  public dispose(): void {
    if (this.reloadTimer !== undefined) {
      clearTimeout(this.reloadTimer);
    }
    this.fileWatcher?.dispose();
    this.diagnostics.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private scheduleReload(document: vscode.TextDocument): void {
    if (this.reloadTimer !== undefined) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      void this.load(document.uri, document.getText(), true);
    }, 250);
  }

  private canAutoActivateCatalog(uri: vscode.Uri): boolean {
    return shouldAutoActivateCatalog(
      this.activeCatalog?.uri.toString(),
      uri.toString(),
      this.ignoredCatalogUri,
    );
  }

  private async ensureActiveCatalog(): Promise<boolean> {
    if (this.activeCatalog !== undefined) {
      return true;
    }

    const action = await vscode.window.showQuickPick([
      {
        label: '创建项目集合模板',
        description: '创建一个新的带注释集合文件',
        value: 'create' as const,
      },
      {
        label: '打开已有项目集合',
        description: '选择一个 *.project-butler.json 文件',
        value: 'open' as const,
      },
    ], {
      title: '添加项目前需要一个项目集合',
      placeHolder: '请选择项目集合来源',
    });
    if (action?.value === 'create') {
      await this.createCatalogTemplate();
    } else if (action?.value === 'open') {
      await this.selectCatalogFile();
    }
    return this.activeCatalog !== undefined;
  }

  private async selectProjectResource(): Promise<SelectedProjectResource | undefined> {
    const currentProject = this.getCurrentWindowProject();
    const choices = [
      ...(currentProject === undefined
        ? []
        : [{
          label: '添加当前窗口项目',
          description: currentProject.uri.fsPath,
          value: 'current' as const,
        }]),
      {
        label: '选择其他项目',
        description: '选择文件夹或 .code-workspace 文件',
        value: 'select' as const,
      },
    ];
    const choice = await vscode.window.showQuickPick(choices, {
      title: '添加项目到当前集合',
      placeHolder: '请选择项目来源',
    });
    if (choice?.value === 'current') {
      return currentProject;
    }
    if (choice?.value !== 'select') {
      return undefined;
    }

    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: false,
      filters: { 'VS Code 工作区': ['code-workspace'] },
      openLabel: '选择项目',
      title: '选择项目文件夹或 .code-workspace 文件',
    });
    const uri = selected?.[0];
    if (uri === undefined) {
      return undefined;
    }

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.Directory) !== 0) {
        return {
          uri,
          type: 'folder',
          suggestedAlias: path.posix.basename(uri.path) || '项目',
        };
      }
      if (uri.path.toLocaleLowerCase().endsWith('.code-workspace')) {
        return {
          uri,
          type: 'workspace',
          suggestedAlias: path.posix.basename(uri.path, '.code-workspace') || '工作区',
        };
      }
      await vscode.window.showErrorMessage('只能添加文件夹或 .code-workspace 文件。');
    } catch (error) {
      await vscode.window.showErrorMessage(`无法访问所选项目：${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }

  private getCurrentWindowProject(): SelectedProjectResource | undefined {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile !== undefined && workspaceFile.scheme !== 'untitled') {
      return {
        uri: workspaceFile,
        type: 'workspace',
        suggestedAlias: path.posix.basename(workspaceFile.path, '.code-workspace') || '工作区',
      };
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length === 1 && folders[0] !== undefined) {
      return {
        uri: folders[0].uri,
        type: 'folder',
        suggestedAlias: folders[0].name,
      };
    }
    return undefined;
  }

  private createPortableRelativePath(catalogUri: vscode.Uri, projectUri: vscode.Uri): string | undefined {
    if (catalogUri.scheme !== projectUri.scheme || catalogUri.authority !== projectUri.authority) {
      return undefined;
    }

    let relativePath: string;
    if (catalogUri.scheme === 'file') {
      relativePath = path.relative(path.dirname(catalogUri.fsPath), projectUri.fsPath);
      if (path.isAbsolute(relativePath)) {
        return undefined;
      }
      relativePath = relativePath.replace(/\\/gu, '/');
    } else {
      relativePath = path.posix.relative(path.posix.dirname(catalogUri.path), projectUri.path);
    }

    if (relativePath.length === 0) {
      return '.';
    }
    return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
  }

  private hasDuplicateProjectUri(catalog: ActiveProjectCatalog, uri: vscode.Uri): boolean {
    const target = this.uriComparisonKey(uri);
    return catalog.projects.some((project) => project.uri !== undefined && this.uriComparisonKey(project.uri) === target);
  }

  private uriComparisonKey(uri: vscode.Uri): string {
    const value = uri.toString();
    return uri.scheme === 'file' && process.platform === 'win32' ? value.toLocaleLowerCase() : value;
  }

  private validateAlias(value: string, catalog: ActiveProjectCatalog): string | undefined {
    const alias = value.trim();
    if (alias.length === 0) {
      return '别名不能为空。';
    }
    if (alias.length > 64) {
      return '别名不能超过 64 个字符。';
    }
    if (catalog.projects.some((project) => project.alias.toLocaleLowerCase() === alias.toLocaleLowerCase())) {
      return '该别名已经存在于当前项目集合。';
    }
    return undefined;
  }

  private async writeTabSettings(catalogUri: vscode.Uri, settings: CatalogTabSettings): Promise<void> {
    const document = await vscode.workspace.openTextDocument(catalogUri);
    if (document.isDirty) {
      await vscode.window.showWarningMessage('项目集合文件存在未保存的修改，请先保存后再更新标签配置。');
      return;
    }

    let edits;
    try {
      edits = createCatalogTabSettingsEdits(document.getText(), settings);
    } catch (error) {
      await vscode.window.showErrorMessage(`无法定位标签配置：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of edits) {
      workspaceEdit.replace(
        catalogUri,
        new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
        edit.text,
      );
    }
    if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
      await vscode.window.showErrorMessage('标签配置写入失败，集合文件未修改。');
      return;
    }
    if (!(await document.save())) {
      await vscode.window.showErrorMessage('标签配置已经写入编辑器，但保存失败，请手动保存。');
      return;
    }
    await this.load(catalogUri, document.getText(), true);
    await vscode.window.showInformationMessage('项目集合的标签配置已更新。');
  }

  private async writeOutlineSettings(
    catalogUri: vscode.Uri,
    settings: CatalogSymbolOutlineSettings,
  ): Promise<void> {
    const document = await vscode.workspace.openTextDocument(catalogUri);
    if (document.isDirty) {
      await vscode.window.showWarningMessage('项目集合文件存在未保存的修改，请先保存后再更新函数大纲配置。');
      return;
    }

    let edits;
    try {
      edits = createCatalogSymbolOutlineSettingsEdits(document.getText(), settings);
    } catch (error) {
      await vscode.window.showErrorMessage(`无法定位函数大纲配置：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of edits) {
      workspaceEdit.replace(
        catalogUri,
        new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
        edit.text,
      );
    }
    if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
      await vscode.window.showErrorMessage('函数大纲配置写入失败，集合文件未修改。');
      return;
    }
    if (!(await document.save())) {
      await vscode.window.showErrorMessage('函数大纲配置已经写入编辑器，但保存失败，请手动保存。');
      return;
    }
    await this.load(catalogUri, document.getText(), true);
    const appliesNow = this.projectContext.kind === 'member';
    const inspected = vscode.workspace.getConfiguration('projectManager.symbolOutline').inspect<string>('mode');
    const hasWorkspaceOverride = inspected?.workspaceFolderValue !== undefined
      || inspected?.workspaceValue !== undefined;
    await vscode.window.showInformationMessage(
      appliesNow && hasWorkspaceOverride
        ? '项目集合的函数大纲配置已更新；当前工作区存在更高优先级的大纲模式覆盖，集合值暂不生效。'
        : appliesNow
        ? '项目集合的函数大纲配置已更新并应用。'
        : '项目集合的函数大纲配置已更新；当前窗口不是集合内项目，打开集合项目后生效。',
    );
  }

  private async rememberProjectBinding(projectUri: vscode.Uri, catalogUri: vscode.Uri): Promise<void> {
    const bindings = this.context.globalState.get<Record<string, string>>(PROJECT_BINDINGS_KEY, {});
    await this.context.globalState.update(PROJECT_BINDINGS_KEY, {
      ...bindings,
      [this.uriComparisonKey(projectUri)]: catalogUri.toString(),
    });
  }

  private getCurrentProjectKey(): string | undefined {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile !== undefined && workspaceFile.scheme !== 'untitled') {
      return this.uriComparisonKey(workspaceFile);
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders?.length === 1 && folders[0] !== undefined
      ? this.uriComparisonKey(folders[0].uri)
      : undefined;
  }

  private hasCurrentWorkspace(): boolean {
    const workspaceFile = vscode.workspace.workspaceFile;
    return (workspaceFile !== undefined && workspaceFile.scheme !== 'untitled')
      || (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  }

  private async appendProject(catalogUri: vscode.Uri, project: NewCatalogProject): Promise<void> {
    const document = await vscode.workspace.openTextDocument(catalogUri);
    if (document.isDirty) {
      await vscode.window.showWarningMessage('项目集合文件存在未保存的修改，请先保存后再添加项目。');
      return;
    }

    const source = document.getText();
    const latestCatalog = parseProjectCatalogText(source);
    if (latestCatalog.issues.some((issue) => issue.severity === 'error' && issue.projectIndex === undefined)) {
      await vscode.window.showErrorMessage('项目集合存在全局格式错误，请先修复后再添加项目。');
      return;
    }
    if (latestCatalog.projects.some((item) => item.alias.toLocaleLowerCase() === project.alias.toLocaleLowerCase())) {
      await vscode.window.showWarningMessage(`项目别名“${project.alias}”已经存在，未写入重复条目。`);
      return;
    }
    const projectPathKey = this.relativePathComparisonKey(project.path, catalogUri);
    if (latestCatalog.projects.some((item) => this.relativePathComparisonKey(item.path, catalogUri) === projectPathKey)) {
      await vscode.window.showWarningMessage(`项目路径“${project.path}”已经存在，未写入重复条目。`);
      return;
    }

    let insertion;
    try {
      insertion = createCatalogProjectInsertion(source, project);
    } catch (error) {
      await vscode.window.showErrorMessage(`无法定位 projects 数组：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    if (insertion.commaOffset !== undefined) {
      edit.insert(catalogUri, document.positionAt(insertion.commaOffset), ',');
    }
    edit.insert(catalogUri, document.positionAt(insertion.entryOffset), insertion.entryText);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      await vscode.window.showErrorMessage('项目条目写入失败，集合文件未保存。');
      return;
    }
    if (!(await document.save())) {
      await vscode.window.showErrorMessage('项目条目已经加入编辑器，但集合文件保存失败，请手动保存。');
      return;
    }

    await this.load(catalogUri, document.getText(), true);
    await vscode.window.showInformationMessage(`已将“${project.alias}”添加到项目集合。`);
  }

  private relativePathComparisonKey(relativePath: string, catalogUri: vscode.Uri): string {
    const normalized = path.posix.normalize(relativePath);
    return catalogUri.scheme === 'file' && process.platform === 'win32'
      ? normalized.toLocaleLowerCase()
      : normalized;
  }

  private async load(uri: vscode.Uri, suppliedText: string | undefined, remember: boolean): Promise<void> {
    try {
      const text = suppliedText ?? await this.readText(uri);
      const catalog = parseProjectCatalogText(text);
      const hasCatalogError = catalog.issues.some((issue) => issue.severity === 'error' && issue.projectIndex === undefined);
      const projects = hasCatalogError
        ? catalog.projects.map((project): ResolvedCatalogProject => ({
          ...project,
          uri: undefined,
          available: false,
          runtimeIssue: '项目集合存在全局格式错误，修复后才能打开项目。',
        }))
        : await Promise.all(catalog.projects.map(async (project) => this.resolveProject(uri, project)));
      this.activeCatalog = { uri, catalog, projects };
      this.restoreIssue = undefined;
      this.updateDiagnostics(uri, catalog.issues, projects);
      this.changeEmitter.fire(this.activeCatalog);
      this.configureFileWatcher(uri);
      await this.context.workspaceState.update(WORKSPACE_CATALOG_KEY, uri.toString());
      await this.context.workspaceState.update(RESTORE_ENABLED_KEY, true);
      if (remember) {
        await this.context.globalState.update(LAST_CATALOG_KEY, uri.toString());
      }
      this.output.appendLine(`已加载项目集合：${uri.toString()}（${projects.length} 个项目）`);
    } catch (error) {
      const message = `无法读取项目集合：${error instanceof Error ? error.message : String(error)}`;
      this.restoreIssue = message;
      this.output.appendLine(message);
      this.diagnostics.set(uri, [new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        message,
        vscode.DiagnosticSeverity.Error,
      )]);
      if (remember) {
        await vscode.window.showErrorMessage(message);
      }
      this.changeEmitter.fire(this.activeCatalog);
    }
  }

  private async readText(uri: vscode.Uri): Promise<string> {
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    if (openDocument !== undefined) {
      return openDocument.getText();
    }
    return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
  }

  private async resolveProject(catalogUri: vscode.Uri, project: CatalogProject): Promise<ResolvedCatalogProject> {
    if (project.issues.some((issue) => issue.severity === 'error') || project.path.length === 0) {
      return { ...project, uri: undefined, available: false };
    }

    const baseUri = vscode.Uri.joinPath(catalogUri, '..');
    const targetUri = vscode.Uri.joinPath(baseUri, ...project.path.split('/'));
    try {
      const stat = await vscode.workspace.fs.stat(targetUri);
      const expectsWorkspaceFile = project.type === 'workspace'
        || (project.type === 'auto' && project.path.toLocaleLowerCase().endsWith('.code-workspace'));
      const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
      if (expectsWorkspaceFile && isDirectory) {
        return {
          ...project,
          uri: targetUri,
          available: false,
          runtimeIssue: `“${project.alias}”应指向 .code-workspace 文件，但当前路径是目录。`,
        };
      }
      if (!expectsWorkspaceFile && !isDirectory) {
        return {
          ...project,
          uri: targetUri,
          available: false,
          runtimeIssue: `“${project.alias}”应指向文件夹，但当前路径不是目录。`,
        };
      }
      return { ...project, uri: targetUri, available: true };
    } catch {
      return {
        ...project,
        uri: targetUri,
        available: false,
        runtimeIssue: `项目“${project.alias}”的路径不存在或无法访问：${project.path}`,
      };
    }
  }

  private updateDiagnostics(
    uri: vscode.Uri,
    catalogIssues: readonly CatalogIssue[],
    projects: readonly ResolvedCatalogProject[],
  ): void {
    const diagnostics = catalogIssues.map((issue) => new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      issue.message,
      issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
    ));
    diagnostics.push(...projects
      .filter((project) => project.runtimeIssue !== undefined)
      .map((project) => new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        project.runtimeIssue ?? '',
        vscode.DiagnosticSeverity.Warning,
      )));
    this.diagnostics.set(uri, diagnostics);
  }

  private configureFileWatcher(uri: vscode.Uri): void {
    this.fileWatcher?.dispose();
    const baseUri = vscode.Uri.joinPath(uri, '..');
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(baseUri, path.posix.basename(uri.path)),
    );
    this.fileWatcher.onDidChange(() => { void this.load(uri, undefined, false); });
    this.fileWatcher.onDidCreate(() => { void this.load(uri, undefined, false); });
  }
}

function isSameTabSettings(left: CatalogTabSettings, right: CatalogTabSettings): boolean {
  return left.autoOrganize === right.autoOrganize;
}

function formatOutlineMode(mode: 'native' | 'enhanced' | 'both'): string {
  switch (mode) {
    case 'native':
      return '仅原生';
    case 'enhanced':
      return '仅增强';
    case 'both':
      return '同时使用';
  }
}
