import * as path from 'node:path';
import * as vscode from 'vscode';
import { ProjectFeatureConfigurationSource } from '../configuration/configurationTypes';
import { CatalogTodoOverrides } from '../todo/todoSettings';
import {
  CatalogSymbolOutlineSettings,
  CatalogTabSettings,
} from './catalogModel';
import {
  appendCatalog,
  CatalogLibrary,
  chooseStoredCatalogToRestore,
  createStoredCatalog,
  createEmptyCatalogLibrary,
  createStoredProject,
  loadCatalogLibrary,
  replaceCatalog,
  StoredCatalogProject,
  StoredProjectCatalog,
  withRenamedCatalog,
  withRenamedProject,
  withUpdatedCatalog,
  withUpdatedProjectResource,
  withoutStoredProject,
} from './catalogStore';
import { createExportText, ImportPreview, parseImportText } from './catalogTransfer';

const LIBRARY_KEY = 'projectManager.catalogLibrary.v1';
const ACTIVE_CATALOG_ID_KEY = 'projectManager.catalogLibrary.activeId';
const LAST_ACTIVE_CATALOG_ID_KEY = 'projectManager.catalogLibrary.lastActiveId';
const PROJECT_BINDINGS_KEY = 'projectManager.catalogLibrary.projectBindings';
const RESTORE_SUPPRESSED_KEY = 'projectManager.catalogLibrary.restoreSuppressed';
const LEGACY_WORKSPACE_CATALOG_KEY = 'projectManager.projectCatalog.workspaceUri';

export type CatalogTabSettingKey = keyof CatalogTabSettings;
export type CatalogTodoSettingKey = 'enabled' | 'markdownTasks';

export interface ResolvedCatalogProject {
  readonly catalogId: string;
  readonly id: string;
  readonly index: number;
  readonly alias: string;
  readonly path: string;
  readonly type: 'folder' | 'workspace';
  readonly description?: string;
  readonly tags: readonly string[];
  readonly uri: vscode.Uri;
  readonly available: boolean;
  readonly runtimeIssue?: string;
}

export interface ActiveProjectCatalogV2 {
  readonly id: string;
  readonly name: string;
  readonly features: StoredProjectCatalog['features'];
  readonly projects: readonly ResolvedCatalogProject[];
  readonly updatedAt: string;
}

interface SelectedProjectResource {
  readonly uri: vscode.Uri;
  readonly type: 'folder' | 'workspace';
  readonly suggestedAlias: string;
}

export class ProjectCatalogServiceV2 implements vscode.Disposable, ProjectFeatureConfigurationSource {
  private readonly changeEmitter = new vscode.EventEmitter<ActiveProjectCatalogV2 | undefined>();
  private library: CatalogLibrary = createEmptyCatalogLibrary();
  private activeCatalog: ActiveProjectCatalogV2 | undefined;
  private legacyCatalogUri: vscode.Uri | undefined;
  private revision = 0;

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  public get current(): ActiveProjectCatalogV2 | undefined {
    return this.activeCatalog;
  }

  public get catalogs(): readonly StoredProjectCatalog[] {
    return this.library.catalogs;
  }

  public get configurationRevision(): number {
    return this.revision;
  }

  public get hasLegacyCatalogToImport(): boolean {
    return this.legacyCatalogUri !== undefined;
  }

  public get projectContext(): ProjectFeatureConfigurationSource['projectContext'] {
    if (!this.hasCurrentWorkspace()) {
      return { kind: 'noWorkspace' };
    }
    const projectKey = this.getCurrentProjectKey();
    const project = projectKey === undefined
      ? undefined
      : this.activeCatalog?.projects.find((candidate) => this.uriComparisonKey(candidate.uri) === projectKey);
    return project === undefined ? { kind: 'external' } : { kind: 'member', project };
  }

  public get currentProjectTabSettings(): CatalogTabSettings | undefined {
    if (this.projectContext.kind !== 'member') return undefined;
    const autoOrganize = this.activeCatalog?.features.tabs.autoOrganize;
    return autoOrganize === undefined ? undefined : { autoOrganize };
  }

  public get currentProjectSymbolOutlineSettings(): CatalogSymbolOutlineSettings | undefined {
    if (this.projectContext.kind !== 'member') return undefined;
    const mode = this.activeCatalog?.features.symbolOutline.mode;
    return mode === undefined ? undefined : { mode };
  }

  public get currentProjectTodoSettings(): CatalogTodoOverrides | undefined {
    if (this.projectContext.kind !== 'member') return undefined;
    const todo = this.activeCatalog?.features.todo;
    return todo === undefined || Object.keys(todo).length === 0 ? undefined : todo;
  }

  public async initialize(): Promise<void> {
    const loaded = loadCatalogLibrary(this.context.globalState.get<unknown>(LIBRARY_KEY));
    this.library = loaded.library;
    for (const issue of loaded.issues) {
      this.output.appendLine(`内部集合存储：${issue}`);
    }
    const projectKey = this.getCurrentProjectKey();
    const restoreSuppressed = this.context.workspaceState.get<boolean>(RESTORE_SUPPRESSED_KEY, false);
    const bindings = this.context.globalState.get<Record<string, string>>(PROJECT_BINDINGS_KEY, {});
    const storedBoundId = projectKey === undefined ? undefined : bindings[projectKey];
    const boundId = storedBoundId !== undefined && projectKey !== undefined
      && this.library.catalogs.some((catalog) => catalog.id === storedBoundId
        && catalog.projects.some((project) => this.uriComparisonKey(vscode.Uri.parse(project.uri)) === projectKey))
      ? storedBoundId
      : undefined;
    const workspaceId = this.context.workspaceState.get<string>(ACTIVE_CATALOG_ID_KEY);
    const matchingIds = projectKey === undefined ? [] : this.library.catalogs
      .filter((catalog) => catalog.projects.some((project) => this.uriComparisonKey(vscode.Uri.parse(project.uri)) === projectKey))
      .map((catalog) => catalog.id);
    const lastId = this.hasCurrentWorkspace()
      ? undefined
      : this.context.globalState.get<string>(LAST_ACTIVE_CATALOG_ID_KEY);
    const selectedId = chooseStoredCatalogToRestore(
      this.library.catalogs.map((catalog) => catalog.id),
      restoreSuppressed,
      [boundId, workspaceId, matchingIds.length === 1 ? matchingIds[0] : undefined, lastId],
    );
    if (selectedId !== undefined) {
      await this.activateCatalog(selectedId, false);
    } else {
      this.changeEmitter.fire(undefined);
    }
    if (this.library.catalogs.length === 0) {
      const legacyUri = this.context.workspaceState.get<string>(LEGACY_WORKSPACE_CATALOG_KEY);
      if (legacyUri !== undefined && legacyUri.length > 0) {
        this.legacyCatalogUri = vscode.Uri.parse(legacyUri);
      }
    }
  }

  public async selectCatalog(): Promise<void> {
    if (this.library.catalogs.length === 0) {
      const action = await vscode.window.showQuickPick([
        { label: '$(add) 添加项目并创建集合', value: 'add' as const },
        { label: '$(cloud-download) 导入集合', value: 'import' as const },
      ], { title: '尚无项目集合' });
      if (action?.value === 'add') {
        await this.addProjectToCatalog();
      } else if (action?.value === 'import') {
        await this.importCatalog();
      }
      return;
    }
    const selected = await vscode.window.showQuickPick(this.library.catalogs.map((catalog) => ({
      label: catalog.name,
      description: `${catalog.projects.length} 个项目${catalog.id === this.activeCatalog?.id ? ' · 当前集合' : ''}`,
      catalog,
    })), { title: '选择项目集合', placeHolder: '切换管理目标；集合功能只对成员项目生效' });
    if (selected !== undefined) {
      await this.activateCatalog(selected.catalog.id, true);
    }
  }

  public async exitCatalog(): Promise<void> {
    if (this.activeCatalog === undefined) {
      return;
    }
    const name = this.activeCatalog.name;
    this.activeCatalog = undefined;
    await this.context.workspaceState.update(ACTIVE_CATALOG_ID_KEY, '');
    await this.context.globalState.update(LAST_ACTIVE_CATALOG_ID_KEY, '');
    await this.context.workspaceState.update(RESTORE_SUPPRESSED_KEY, true);
    this.revision += 1;
    this.changeEmitter.fire(undefined);
    this.output.appendLine(`已退出项目集合：${name}`);
  }

  public async renameCatalog(catalogId?: string): Promise<void> {
    const target = this.getStoredCatalog(catalogId ?? this.activeCatalog?.id);
    if (target === undefined) {
      await vscode.window.showWarningMessage('项目集合已发生变化，请刷新后重试。');
      return;
    }
    const name = await vscode.window.showInputBox({
      title: '重命名项目集合',
      prompt: '只修改插件中的集合名称，不会重命名或移动任何项目文件。',
      value: target.name,
      valueSelection: [0, target.name.length],
      validateInput: (value) => this.validateCatalogName(value, target.id),
    });
    if (name === undefined || name.trim() === target.name) {
      return;
    }
    if (!await this.updateCatalogName(target.id, name)) {
      await vscode.window.showWarningMessage('集合名称未更新，集合可能已发生变化或名称与其他集合重复。');
      return;
    }
    await vscode.window.showInformationMessage(`项目集合已重命名为“${name.trim()}”。`);
  }

  public async renameProjectAlias(project: ResolvedCatalogProject): Promise<void> {
    const stored = this.getStoredProject(project.catalogId, project.id);
    if (stored === undefined) {
      await vscode.window.showWarningMessage('项目条目已发生变化，请刷新后重试。');
      return;
    }
    const alias = await vscode.window.showInputBox({
      title: '重命名项目别名',
      prompt: '只修改集合中的显示别名，不会重命名真实文件夹或 .code-workspace 文件。',
      value: stored.project.alias,
      valueSelection: [0, stored.project.alias.length],
      validateInput: (value) => this.validateAlias(value, stored.catalog, stored.project.id),
    });
    if (alias === undefined || alias.trim() === stored.project.alias) {
      return;
    }
    if (!await this.updateProjectAlias(stored.catalog.id, stored.project.id, alias)) {
      await vscode.window.showWarningMessage('项目别名未更新，项目可能已发生变化或别名与其他项目重复。');
      return;
    }
    await vscode.window.showInformationMessage(`项目别名已更新为“${alias.trim()}”。`);
  }

  public async reselectProjectPath(project: ResolvedCatalogProject): Promise<void> {
    const stored = this.getStoredProject(project.catalogId, project.id);
    if (stored === undefined) {
      await vscode.window.showWarningMessage('项目条目已发生变化，请刷新后重试。');
      return;
    }
    const resource = await this.selectReplacementProjectResource(vscode.Uri.parse(stored.project.uri), stored.project.type);
    if (resource === undefined) {
      return;
    }
    if (this.hasDuplicateProjectUri(stored.catalog, resource.uri, stored.project.id)) {
      await vscode.window.showWarningMessage('所选路径已经属于当前集合中的其他项目。');
      return;
    }
    if (!await this.updateProjectResource(stored.catalog.id, stored.project.id, resource.uri, resource.type)) {
      await vscode.window.showWarningMessage('项目路径未更新，项目可能已发生变化或新路径与其他项目重复。');
      return;
    }
    await vscode.window.showInformationMessage(`已更新“${stored.project.alias}”的项目路径。`);
  }

  public async removeProjectFromCatalog(project: ResolvedCatalogProject): Promise<void> {
    const stored = this.getStoredProject(project.catalogId, project.id);
    if (stored === undefined) {
      await vscode.window.showWarningMessage('项目条目已发生变化，请刷新后重试。');
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `确认将“${stored.project.alias}”从“${stored.catalog.name}”移出吗？`,
      {
        modal: true,
        detail: `位置：${vscode.Uri.parse(stored.project.uri).fsPath || stored.project.uri}\n\n只移除插件中的集合成员关系，不会删除项目文件夹、.code-workspace、源码或 VS Code 设置。`,
      },
      '确认移出',
    );
    if (confirmed !== '确认移出') {
      return;
    }
    if (!await this.removeProject(stored.catalog.id, stored.project.id)) {
      await vscode.window.showWarningMessage('项目未移出，项目条目可能已发生变化。');
      return;
    }
    await vscode.window.showInformationMessage(`已将“${stored.project.alias}”从“${stored.catalog.name}”移出；磁盘项目保持不变。`);
  }

  /** 为命令和集成测试共用的无对话框集合名称更新入口。 */
  public async updateCatalogName(catalogId: string, name: string): Promise<boolean> {
    const target = this.getStoredCatalog(catalogId);
    if (target === undefined || this.validateCatalogName(name, target.id) !== undefined) {
      return false;
    }
    if (target.name === name.trim()) {
      return true;
    }
    await this.commitLibrary(replaceCatalog(this.library, withRenamedCatalog(target, name)), target.id);
    return true;
  }

  /** 为命令和集成测试共用的无对话框项目别名更新入口。 */
  public async updateProjectAlias(catalogId: string, projectId: string, alias: string): Promise<boolean> {
    const stored = this.getStoredProject(catalogId, projectId);
    if (stored === undefined || this.validateAlias(alias, stored.catalog, projectId) !== undefined) {
      return false;
    }
    if (stored.project.alias === alias.trim()) {
      return true;
    }
    const nextCatalog = withRenamedProject(stored.catalog, projectId, alias);
    await this.commitLibrary(replaceCatalog(this.library, nextCatalog), catalogId);
    return true;
  }

  /** 为命令和集成测试共用的无对话框项目路径更新入口。 */
  public async updateProjectResource(
    catalogId: string,
    projectId: string,
    uri: vscode.Uri,
    type: StoredCatalogProject['type'],
  ): Promise<boolean> {
    const stored = this.getStoredProject(catalogId, projectId);
    if (stored === undefined || this.hasDuplicateProjectUri(stored.catalog, uri, projectId)) {
      return false;
    }
    const oldUri = vscode.Uri.parse(stored.project.uri);
    const nextCatalog = withUpdatedProjectResource(stored.catalog, projectId, uri.toString(), type);
    await this.commitLibrary(replaceCatalog(this.library, nextCatalog), catalogId);
    try {
      await this.replaceProjectBinding(catalogId, oldUri, uri);
    } catch (error) {
      this.output.appendLine(`项目路径已更新，但本地集合绑定刷新失败；下次启动会忽略失效旧绑定：${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  /** 为命令和集成测试共用的无对话框集合成员移出入口。 */
  public async removeProject(catalogId: string, projectId: string): Promise<boolean> {
    const stored = this.getStoredProject(catalogId, projectId);
    if (stored === undefined) {
      return false;
    }
    const projectUri = vscode.Uri.parse(stored.project.uri);
    const nextCatalog = withoutStoredProject(stored.catalog, projectId);
    await this.commitLibrary(replaceCatalog(this.library, nextCatalog), catalogId);
    try {
      await this.removeProjectBinding(catalogId, projectUri);
    } catch (error) {
      this.output.appendLine(`项目已从集合移出，但本地集合绑定清理失败；下次启动会忽略失效旧绑定：${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  public async addProjectToCatalog(): Promise<void> {
    let target = this.getStoredActiveCatalog();
    let newCatalogName: string | undefined;
    let targetAlreadyChosen = false;
    if (target !== undefined) {
      const selected = await vscode.window.showQuickPick([
        {
          label: `$(check) 添加到当前集合：${target.name}`,
          description: '推荐',
          catalog: target,
        },
        ...this.library.catalogs
          .filter((catalog) => catalog.id !== target?.id)
          .map((catalog) => ({ label: catalog.name, description: `${catalog.projects.length} 个项目`, catalog })),
        { label: '$(add) 新建集合', description: '创建集合并添加第一个项目', catalog: undefined },
      ], { title: '添加项目到集合', placeHolder: '选择目标集合' });
      if (selected === undefined) {
        return;
      }
      target = selected.catalog;
      targetAlreadyChosen = true;
    }
    if (target === undefined && this.library.catalogs.length > 0 && !targetAlreadyChosen) {
      const selected = await vscode.window.showQuickPick([
        ...this.library.catalogs.map((catalog) => ({
          label: catalog.name,
          description: `${catalog.projects.length} 个项目`,
          catalog,
        })),
        { label: '$(add) 新建集合', description: '创建集合并添加第一个项目', catalog: undefined },
      ], { title: '添加项目到集合', placeHolder: '选择目标集合' });
      if (selected === undefined) {
        return;
      }
      target = selected.catalog;
    }
    if (target === undefined) {
      newCatalogName = await vscode.window.showInputBox({
        title: '创建项目集合',
        prompt: '集合名称用于在侧栏中识别不同项目组。',
        value: '我的项目',
        validateInput: (value) => this.validateCatalogName(value),
      });
      if (newCatalogName === undefined) {
        return;
      }
    }

    const resource = await this.selectProjectResource();
    if (resource === undefined) {
      return;
    }
    if (target?.projects.some((project) => this.uriComparisonKey(vscode.Uri.parse(project.uri)) === this.uriComparisonKey(resource.uri))) {
      await vscode.window.showWarningMessage('所选项目已经存在于目标集合中。');
      return;
    }
    const alias = await vscode.window.showInputBox({
      title: '设置项目别名',
      prompt: '别名是项目列表中的主标题。',
      value: resource.suggestedAlias,
      validateInput: (value) => this.validateAlias(value, target),
    });
    if (alias === undefined) {
      return;
    }
    const description = await vscode.window.showInputBox({
      title: `“${alias.trim()}”的项目说明`,
      prompt: '可选，留空即可。',
    });
    if (description === undefined) {
      return;
    }
    const tagsInput = await vscode.window.showInputBox({
      title: `“${alias.trim()}”的标签`,
      prompt: '可选，多个标签使用英文逗号分隔。',
    });
    if (tagsInput === undefined) {
      return;
    }
    const project = createStoredProject({
      alias,
      uri: resource.uri.toString(),
      type: resource.type,
      ...(description.trim().length === 0 ? {} : { description }),
      tags: tagsInput.split(','),
    });
    const targetName = target?.name ?? newCatalogName?.trim() ?? '我的项目';
    const confirmed = await vscode.window.showInformationMessage(
      `确认将“${project.alias}”添加到“${targetName}”吗？`,
      { modal: true, detail: `类型：${project.type === 'workspace' ? 'VS Code 工作区' : '文件夹'}\n位置：${resource.uri.fsPath || resource.uri.toString()}` },
      '确认添加',
    );
    if (confirmed !== '确认添加') {
      return;
    }

    let nextLibrary: CatalogLibrary;
    let activeId: string;
    if (target === undefined) {
      const catalog = createStoredCatalog(targetName);
      const populated = withUpdatedCatalog(catalog, { projects: [project] });
      nextLibrary = appendCatalog(this.library, populated);
      activeId = populated.id;
    } else {
      const nextCatalog = withUpdatedCatalog(target, { projects: [...target.projects, project] });
      nextLibrary = replaceCatalog(this.library, nextCatalog);
      activeId = nextCatalog.id;
    }
    await this.commitLibrary(nextLibrary, activeId);
    await vscode.window.showInformationMessage(`已将“${project.alias}”添加到“${targetName}”。`);
  }

  public async configureTabSetting(key: CatalogTabSettingKey): Promise<void> {
    if (key !== 'autoOrganize') {
      return;
    }
    const target = this.projectContext.kind === 'member' ? this.getStoredActiveCatalog() : undefined;
    if (target === undefined) {
      await this.configurePersonalValue('projectManager.tabs', 'autoOrganize', [
        { label: '开启自动移至末尾', value: true },
        { label: '关闭自动移至末尾', value: false },
      ], '个人默认：非项目标签自动移至末尾');
      return;
    }
    const selected = await vscode.window.showQuickPick([
      { label: '跟随个人默认', description: target.features.tabs.autoOrganize === undefined ? '当前值' : '', value: undefined },
      { label: '开启自动移至末尾', description: target.features.tabs.autoOrganize ? '当前值' : '', value: true },
      { label: '关闭自动移至末尾', description: target.features.tabs.autoOrganize === false ? '当前值' : '', value: false },
    ], { title: `配置“${target.name}”：非项目标签自动移至末尾` });
    if (selected === undefined || selected.value === target.features.tabs.autoOrganize) {
      return;
    }
    await this.updateCatalogFeatures(target, {
      ...target.features,
      tabs: selected.value === undefined ? {} : { autoOrganize: selected.value },
    });
  }

  /** 为侧栏和集成测试共用的无对话框写入入口。 */
  public async updateCurrentTabAutoOrganize(autoOrganize: boolean): Promise<boolean> {
    const target = this.projectContext.kind === 'member' ? this.getStoredActiveCatalog() : undefined;
    if (target === undefined) return false;
    if (target.features.tabs.autoOrganize === autoOrganize) return true;
    await this.updateCatalogFeatures(target, {
      ...target.features,
      tabs: { autoOrganize },
    }, false);
    return true;
  }

  public async configureOutlineMode(): Promise<void> {
    const target = this.projectContext.kind === 'member' ? this.getStoredActiveCatalog() : undefined;
    if (target === undefined) {
      await this.configurePersonalValue('projectManager.symbolOutline', 'mode', outlineModeChoices(), '个人默认：函数大纲模式');
      return;
    }
    const selected = await vscode.window.showQuickPick([
      { label: '跟随个人默认', description: target.features.symbolOutline.mode === undefined ? '当前值' : '', value: undefined },
      ...outlineModeChoices(target.features.symbolOutline.mode),
    ], {
      title: `配置“${target.name}”：函数大纲模式`,
    });
    if (selected === undefined || selected.value === target.features.symbolOutline.mode) {
      return;
    }
    await this.updateCatalogFeatures(target, {
      ...target.features,
      symbolOutline: selected.value === undefined ? {} : { mode: selected.value },
    });
  }

  public async updateCurrentOutlineMode(mode: 'native' | 'enhanced' | 'both', showFeedback = true): Promise<boolean> {
    if (this.projectContext.kind !== 'member') {
      return false;
    }
    const target = this.getStoredActiveCatalog();
    if (target === undefined || target.features.symbolOutline.mode === mode) {
      return true;
    }
    await this.updateCatalogFeatures(target, { ...target.features, symbolOutline: { mode } }, showFeedback);
    return true;
  }

  public async configureTodoSetting(key: CatalogTodoSettingKey): Promise<void> {
    const target = this.projectContext.kind === 'member' ? this.getStoredActiveCatalog() : undefined;
    const label = key === 'enabled' ? '代码 TODO' : 'Markdown 未完成项';
    if (target === undefined) {
      await this.configurePersonalValue('projectManager.todo', key, [
        { label: '开启', value: true },
        { label: '关闭', value: false },
      ], `个人默认：${label}`);
      return;
    }
    const current = target.features.todo[key];
    const selected = await vscode.window.showQuickPick([
      { label: '跟随个人默认', description: current === undefined ? '当前值' : '', value: undefined },
      { label: '开启', description: current === true ? '当前值' : '', value: true },
      { label: '关闭', description: current === false ? '当前值' : '', value: false },
    ], { title: `配置“${target.name}”：${label}` });
    if (selected === undefined || selected.value === current) return;
    await this.updateCurrentTodoSetting(key, selected.value);
  }

  public async updateCurrentTodoSetting(
    key: CatalogTodoSettingKey,
    value: boolean | undefined,
    showFeedback = true,
  ): Promise<boolean> {
    return this.updateCurrentTodoOverrides(key, value, showFeedback);
  }

  public async updateCurrentTodoTags(
    tags: readonly string[] | undefined,
    showFeedback = true,
  ): Promise<boolean> {
    return this.updateCurrentTodoOverrides('tags', tags, showFeedback);
  }

  public async refresh(): Promise<void> {
    if (this.activeCatalog !== undefined) {
      await this.activateCatalog(this.activeCatalog.id, false);
    } else {
      this.changeEmitter.fire(undefined);
    }
  }

  /** 仅供隔离的 Extension Host 集成测试建立确定性状态。 */
  public async replaceLibraryForIntegrationTest(library: CatalogLibrary, activeId?: string): Promise<void> {
    await this.context.globalState.update(LIBRARY_KEY, library);
    await this.context.workspaceState.update(ACTIVE_CATALOG_ID_KEY, activeId ?? '');
    await this.context.globalState.update(LAST_ACTIVE_CATALOG_ID_KEY, activeId ?? '');
    await this.context.workspaceState.update(RESTORE_SUPPRESSED_KEY, activeId === undefined);
    await this.context.globalState.update(PROJECT_BINDINGS_KEY, {});
    this.library = library;
    if (activeId === undefined) {
      this.activeCatalog = undefined;
      this.revision += 1;
      this.changeEmitter.fire(undefined);
      return;
    }
    await this.activateCatalog(activeId, false);
  }

  public async openProject(project: ResolvedCatalogProject, mode?: 'newWindow' | 'currentWindow'): Promise<void> {
    if (!project.available) {
      await vscode.window.showErrorMessage(project.runtimeIssue ?? '该项目路径当前不可用，请重新添加或导入时重映射基础目录。');
      return;
    }
    const configuredMode = vscode.workspace.getConfiguration('projectManager.projectCatalog')
      .get<'prompt' | 'newWindow' | 'currentWindow'>('openMode', 'prompt');
    let openMode = mode;
    if (openMode === undefined && configuredMode === 'prompt') {
      const selected = await vscode.window.showQuickPick([
        { label: '在新窗口打开', description: '保留当前窗口', value: 'newWindow' as const },
        { label: '在当前窗口打开', description: '当前窗口切换到所选项目', value: 'currentWindow' as const },
      ], { title: `打开“${project.alias}”` });
      openMode = selected?.value;
    } else if (openMode === undefined) {
      openMode = configuredMode === 'currentWindow' ? 'currentWindow' : 'newWindow';
    }
    if (openMode === undefined) {
      return;
    }
    if (this.activeCatalog !== undefined) {
      await this.rememberProjectBinding(project.uri, this.activeCatalog.id);
    }
    await vscode.commands.executeCommand('vscode.openFolder', project.uri, {
      forceNewWindow: openMode === 'newWindow',
      forceReuseWindow: openMode === 'currentWindow',
    });
  }

  public async importCatalog(explicitUri?: vscode.Uri): Promise<void> {
    const uri = explicitUri ?? (await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { '项目集合与导出文件': ['json'] },
      openLabel: '预览导入',
      title: '选择项目集合导入文件',
    }))?.[0];
    if (uri === undefined) {
      return;
    }
    let preview: ImportPreview;
    try {
      const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
      preview = parseImportText(text, uri);
    } catch (error) {
      await vscode.window.showErrorMessage(`无法导入项目集合：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let importCatalogs = preview.catalogs;
    let unavailableCount = await this.countUnavailableProjects(importCatalogs);
    if (unavailableCount > 0) {
      const pathAction = await vscode.window.showWarningMessage(
        `检测到 ${unavailableCount} 个项目路径当前不可用。可以选择新的基础目录进行一次性重映射。`,
        { modal: true },
        '选择基础目录',
        '保留为不可用',
      );
      if (pathAction === undefined) {
        return;
      }
      if (pathAction === '选择基础目录') {
        const newBase = (await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: '使用此基础目录',
          title: '选择导入项目的新基础目录',
        }))?.[0];
        if (newBase === undefined) {
          return;
        }
        importCatalogs = await this.remapUnavailableProjects(importCatalogs, uri, newBase);
        unavailableCount = await this.countUnavailableProjects(importCatalogs);
      }
    }
    let confirmed = await vscode.window.showInformationMessage(
      `准备导入 ${importCatalogs.length} 个集合，是否继续？`,
      {
        modal: true,
        detail: `兼容字段：${preview.appliedFieldCount}\n使用默认值：${preview.defaultedFieldCount}\n忽略内容：${preview.ignoredFieldCount}\n需重映射路径：${unavailableCount}\n\n导入后源文件不会成为活动配置。`,
      },
      '确认导入',
      '查看详情',
    );
    if (confirmed === '查看详情') {
      this.output.appendLine(`导入预览：${uri.toString()}`);
      for (const message of preview.messages) {
        this.output.appendLine(`- ${message}`);
      }
      this.output.show(true);
      confirmed = await vscode.window.showInformationMessage(
        '兼容详情已显示在“项目管家”输出中，是否继续导入？',
        { modal: true },
        '确认导入',
      );
    }
    if (confirmed !== '确认导入') {
      return;
    }
    let next = this.library;
    const imported: StoredProjectCatalog[] = [];
    for (const catalog of importCatalogs) {
      const unique = { ...catalog, name: this.createUniqueCatalogName(catalog.name, next) };
      next = appendCatalog(next, unique);
      imported.push(unique);
    }
    if (imported.length === 0) {
      await vscode.window.showWarningMessage('导入文件中没有可用集合。');
      return;
    }
    await this.commitLibrary(next, imported[0]?.id);
    this.legacyCatalogUri = undefined;
    await vscode.window.showInformationMessage(`已导入 ${imported.length} 个集合；兼容配置已立即生效。`);
  }

  public async importLegacyCatalog(): Promise<void> {
    if (this.legacyCatalogUri === undefined) {
      await this.importCatalog();
      return;
    }
    await this.importCatalog(this.legacyCatalogUri);
  }

  public async exportCatalog(): Promise<void> {
    if (this.library.catalogs.length === 0) {
      await vscode.window.showInformationMessage('当前没有可导出的项目集合。');
      return;
    }
    let catalogs: readonly StoredProjectCatalog[];
    if (this.library.catalogs.length === 1) {
      catalogs = this.library.catalogs;
    } else {
      const selected = await vscode.window.showQuickPick([
        { label: '导出全部集合', description: `${this.library.catalogs.length} 个集合`, value: 'all' as const },
        ...(this.getStoredActiveCatalog() === undefined ? [] : [{ label: '仅导出当前集合', description: this.activeCatalog?.name ?? '', value: 'current' as const }]),
      ], { title: '选择导出范围' });
      if (selected === undefined) {
        return;
      }
      catalogs = selected.value === 'all' ? this.library.catalogs : [this.getStoredActiveCatalog()!];
    }
    const suggestedBase = vscode.workspace.workspaceFolders?.[0]?.uri;
    const selectedUri = await vscode.window.showSaveDialog({
      filters: { '项目管家导出文件': ['project-butler-export.json'] },
      saveLabel: '导出集合',
      title: '选择迁移快照保存位置',
      ...(suggestedBase === undefined ? {} : { defaultUri: vscode.Uri.joinPath(suggestedBase, 'project-butler-export.json') }),
    });
    if (selectedUri === undefined) {
      return;
    }
    try {
      await vscode.workspace.fs.stat(selectedUri);
      await vscode.window.showErrorMessage('所选导出文件已经存在，为避免覆盖数据，请选择新的文件名。');
      return;
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') {
        await vscode.window.showErrorMessage(`无法确认导出位置：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    const result = createExportText(catalogs, selectedUri);
    if (result.nonPortableProjectCount > 0) {
      const confirmed = await vscode.window.showWarningMessage(
        `${result.nonPortableProjectCount} 个项目无法生成相对路径，将以 URI 保存并在其他设备上可能需要重新添加。`,
        { modal: true },
        '仍然导出',
      );
      if (confirmed !== '仍然导出') {
        return;
      }
    }
    await vscode.workspace.fs.writeFile(selectedUri, new TextEncoder().encode(result.text));
    await vscode.window.showInformationMessage(`已导出 ${catalogs.length} 个集合：${selectedUri.fsPath || selectedUri.toString()}`);
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  private async updateCatalogFeatures(
    catalog: StoredProjectCatalog,
    features: StoredProjectCatalog['features'],
    showFeedback = true,
  ): Promise<void> {
    const next = replaceCatalog(this.library, withUpdatedCatalog(catalog, { features }));
    await this.commitLibrary(next, catalog.id);
    const appliesNow = this.projectContext.kind === 'member';
    if (showFeedback) {
      await vscode.window.showInformationMessage(appliesNow ? '配置已保存并应用。' : '配置已保存；打开该集合的项目后应用。');
    }
  }

  private async updateCurrentTodoOverrides(
    key: 'enabled' | 'tags' | 'markdownTasks',
    value: boolean | readonly string[] | undefined,
    showFeedback: boolean,
  ): Promise<boolean> {
    if (this.projectContext.kind !== 'member') return false;
    const target = this.getStoredActiveCatalog();
    if (target === undefined) return false;
    const todo: { enabled?: boolean; tags?: readonly string[]; markdownTasks?: boolean } = { ...target.features.todo };
    if (value === undefined) {
      delete todo[key];
    } else if (key === 'tags' && Array.isArray(value)) {
      todo.tags = value;
    } else if (key === 'enabled' && typeof value === 'boolean') {
      todo.enabled = value;
    } else if (key === 'markdownTasks' && typeof value === 'boolean') {
      todo.markdownTasks = value;
    }
    await this.updateCatalogFeatures(target, { ...target.features, todo }, showFeedback);
    return true;
  }

  private async configurePersonalValue<T extends string | boolean>(
    section: string,
    key: string,
    choices: readonly { readonly label: string; readonly value: T }[],
    title: string,
  ): Promise<void> {
    const selected = await vscode.window.showQuickPick(choices, { title });
    if (selected !== undefined) {
      await vscode.workspace.getConfiguration(section).update(key, selected.value, vscode.ConfigurationTarget.Global);
    }
  }

  private async commitLibrary(next: CatalogLibrary, activeId: string | undefined): Promise<void> {
    await this.context.globalState.update(LIBRARY_KEY, next);
    this.library = next;
    if (activeId !== undefined) {
      await this.activateCatalog(activeId, true);
    } else {
      this.revision += 1;
      this.changeEmitter.fire(this.activeCatalog);
    }
  }

  private async activateCatalog(id: string, remember: boolean): Promise<void> {
    const catalog = this.library.catalogs.find((candidate) => candidate.id === id);
    if (catalog === undefined) {
      return;
    }
    const projects = await Promise.all(catalog.projects.map(async (project, index) => this.resolveProject(catalog.id, project, index)));
    this.activeCatalog = {
      id: catalog.id,
      name: catalog.name,
      features: catalog.features,
      projects,
      updatedAt: catalog.updatedAt,
    };
    await this.context.workspaceState.update(ACTIVE_CATALOG_ID_KEY, id);
    await this.context.workspaceState.update(RESTORE_SUPPRESSED_KEY, false);
    if (remember) {
      await this.context.globalState.update(LAST_ACTIVE_CATALOG_ID_KEY, id);
      const matchingProject = projects.find((project) => this.uriComparisonKey(project.uri) === this.getCurrentProjectKey());
      if (matchingProject !== undefined) {
        await this.rememberProjectBinding(matchingProject.uri, id);
      }
    }
    this.revision += 1;
    this.changeEmitter.fire(this.activeCatalog);
    this.output.appendLine(`配置修订 ${this.revision}：活动集合“${catalog.name}”（${projects.length} 个项目）`);
  }

  private async resolveProject(catalogId: string, project: StoredCatalogProject, index: number): Promise<ResolvedCatalogProject> {
    const uri = vscode.Uri.parse(project.uri);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
      if ((project.type === 'folder') !== isDirectory) {
        return this.createResolvedProject(catalogId, project, index, uri, false,
          project.type === 'folder' ? '项目应指向文件夹，但当前路径不是目录。' : '项目应指向 .code-workspace 文件，但当前路径是目录。');
      }
      return this.createResolvedProject(catalogId, project, index, uri, true);
    } catch {
      return this.createResolvedProject(catalogId, project, index, uri, false, `项目路径不存在或无法访问：${uri.fsPath || uri.toString()}`);
    }
  }

  private createResolvedProject(
    catalogId: string,
    project: StoredCatalogProject,
    index: number,
    uri: vscode.Uri,
    available: boolean,
    runtimeIssue?: string,
  ): ResolvedCatalogProject {
    return {
      catalogId,
      id: project.id,
      index,
      alias: project.alias,
      path: uri.fsPath || uri.toString(),
      type: project.type,
      ...(project.description === undefined ? {} : { description: project.description }),
      tags: project.tags,
      uri,
      available,
      ...(runtimeIssue === undefined ? {} : { runtimeIssue }),
    };
  }

  private async selectProjectResource(): Promise<SelectedProjectResource | undefined> {
    const current = this.getCurrentWindowProject();
    const choice = await vscode.window.showQuickPick([
      ...(current === undefined ? [] : [{ label: '添加当前窗口项目', description: current.uri.fsPath, value: current }]),
      { label: '选择其他项目', description: '选择文件夹或 .code-workspace 文件', value: undefined },
    ], { title: '选择要添加的项目' });
    if (choice === undefined) {
      return undefined;
    }
    if (choice.value !== undefined) {
      return choice.value;
    }
    const uri = (await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: false,
      filters: { 'VS Code 工作区': ['code-workspace'] },
      openLabel: '选择项目',
    }))?.[0];
    if (uri === undefined) {
      return undefined;
    }
    return this.inspectProjectResource(uri);
  }

  private async selectReplacementProjectResource(
    currentUri: vscode.Uri,
    currentType: StoredCatalogProject['type'],
  ): Promise<SelectedProjectResource | undefined> {
    const uri = (await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: currentType === 'folder' ? currentUri : vscode.Uri.joinPath(currentUri, '..'),
      filters: { 'VS Code 工作区': ['code-workspace'] },
      openLabel: '使用此项目路径',
      title: '重新选择项目路径',
    }))?.[0];
    return uri === undefined ? undefined : this.inspectProjectResource(uri);
  }

  private async inspectProjectResource(uri: vscode.Uri): Promise<SelectedProjectResource | undefined> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.window.showErrorMessage('所选项目路径不存在或无法访问。');
      return undefined;
    }
    const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
    if (!isDirectory && !uri.path.toLocaleLowerCase().endsWith('.code-workspace')) {
      await vscode.window.showErrorMessage('只能添加文件夹或 .code-workspace 文件。');
      return undefined;
    }
    return {
      uri,
      type: isDirectory ? 'folder' : 'workspace',
      suggestedAlias: isDirectory ? path.posix.basename(uri.path) || '项目' : path.posix.basename(uri.path, '.code-workspace') || '工作区',
    };
  }

  private getCurrentWindowProject(): SelectedProjectResource | undefined {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile !== undefined && workspaceFile.scheme !== 'untitled') {
      return { uri: workspaceFile, type: 'workspace', suggestedAlias: path.posix.basename(workspaceFile.path, '.code-workspace') || '工作区' };
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders?.length === 1 && folders[0] !== undefined
      ? { uri: folders[0].uri, type: 'folder', suggestedAlias: folders[0].name }
      : undefined;
  }

  private validateCatalogName(value: string, excludeCatalogId?: string): string | undefined {
    const name = value.trim();
    if (name.length === 0) return '集合名称不能为空。';
    if (name.length > 80) return '集合名称不能超过 80 个字符。';
    return this.library.catalogs.some((catalog) => catalog.id !== excludeCatalogId
      && catalog.name.toLocaleLowerCase() === name.toLocaleLowerCase())
      ? '该集合名称已经存在。'
      : undefined;
  }

  private validateAlias(value: string, catalog: StoredProjectCatalog | undefined, excludeProjectId?: string): string | undefined {
    const alias = value.trim();
    if (alias.length === 0) return '别名不能为空。';
    if (alias.length > 64) return '别名不能超过 64 个字符。';
    return catalog?.projects.some((project) => project.id !== excludeProjectId
      && project.alias.toLocaleLowerCase() === alias.toLocaleLowerCase())
      ? '该别名已经存在于目标集合。'
      : undefined;
  }

  private hasDuplicateProjectUri(catalog: StoredProjectCatalog, uri: vscode.Uri, excludeProjectId?: string): boolean {
    const key = this.uriComparisonKey(uri);
    return catalog.projects.some((project) => project.id !== excludeProjectId
      && this.uriComparisonKey(vscode.Uri.parse(project.uri)) === key);
  }

  private getStoredCatalog(catalogId: string | undefined): StoredProjectCatalog | undefined {
    return catalogId === undefined ? undefined : this.library.catalogs.find((catalog) => catalog.id === catalogId);
  }

  private getStoredProject(
    catalogId: string,
    projectId: string,
  ): { readonly catalog: StoredProjectCatalog; readonly project: StoredCatalogProject } | undefined {
    const catalog = this.getStoredCatalog(catalogId);
    const project = catalog?.projects.find((candidate) => candidate.id === projectId);
    return catalog === undefined || project === undefined ? undefined : { catalog, project };
  }

  private getStoredActiveCatalog(): StoredProjectCatalog | undefined {
    return this.getStoredCatalog(this.activeCatalog?.id);
  }

  private getCurrentProjectKey(): string | undefined {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile !== undefined && workspaceFile.scheme !== 'untitled') {
      return this.uriComparisonKey(workspaceFile);
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders?.length === 1 && folders[0] !== undefined ? this.uriComparisonKey(folders[0].uri) : undefined;
  }

  private hasCurrentWorkspace(): boolean {
    return this.getCurrentProjectKey() !== undefined || (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  }

  private uriComparisonKey(uri: vscode.Uri): string {
    const value = uri.toString();
    return uri.scheme === 'file' && process.platform === 'win32' ? value.toLocaleLowerCase() : value;
  }

  private async rememberProjectBinding(projectUri: vscode.Uri, catalogId: string): Promise<void> {
    const bindings = this.context.globalState.get<Record<string, string>>(PROJECT_BINDINGS_KEY, {});
    await this.context.globalState.update(PROJECT_BINDINGS_KEY, { ...bindings, [this.uriComparisonKey(projectUri)]: catalogId });
  }

  private async replaceProjectBinding(catalogId: string, oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const bindings = this.context.globalState.get<Record<string, string>>(PROJECT_BINDINGS_KEY, {});
    const oldKey = this.uriComparisonKey(oldUri);
    const next = Object.fromEntries(Object.entries(bindings)
      .filter(([key, value]) => key !== oldKey || value !== catalogId));
    next[this.uriComparisonKey(newUri)] = catalogId;
    await this.context.globalState.update(PROJECT_BINDINGS_KEY, next);
  }

  private async removeProjectBinding(catalogId: string, projectUri: vscode.Uri): Promise<void> {
    const bindings = this.context.globalState.get<Record<string, string>>(PROJECT_BINDINGS_KEY, {});
    const projectKey = this.uriComparisonKey(projectUri);
    const next = Object.fromEntries(Object.entries(bindings)
      .filter(([key, value]) => key !== projectKey || value !== catalogId));
    await this.context.globalState.update(PROJECT_BINDINGS_KEY, next);
  }

  private createUniqueCatalogName(name: string, library: CatalogLibrary): string {
    const names = new Set(library.catalogs.map((catalog) => catalog.name.toLocaleLowerCase()));
    if (!names.has(name.toLocaleLowerCase())) return name;
    let suffix = 2;
    while (names.has(`${name} (${suffix})`.toLocaleLowerCase())) suffix += 1;
    return `${name} (${suffix})`;
  }

  private async countUnavailableProjects(catalogs: readonly StoredProjectCatalog[]): Promise<number> {
    let count = 0;
    for (const catalog of catalogs) {
      for (const project of catalog.projects) {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.parse(project.uri));
        } catch {
          count += 1;
        }
      }
    }
    return count;
  }

  private async remapUnavailableProjects(
    catalogs: readonly StoredProjectCatalog[],
    sourceUri: vscode.Uri,
    newBase: vscode.Uri,
  ): Promise<readonly StoredProjectCatalog[]> {
    const sourceBase = vscode.Uri.joinPath(sourceUri, '..');
    const result: StoredProjectCatalog[] = [];
    for (const catalog of catalogs) {
      const projects: StoredCatalogProject[] = [];
      for (const project of catalog.projects) {
        const originalUri = vscode.Uri.parse(project.uri);
        let available = true;
        try {
          await vscode.workspace.fs.stat(originalUri);
        } catch {
          available = false;
        }
        if (available || originalUri.scheme !== sourceBase.scheme || originalUri.authority !== sourceBase.authority
          || newBase.scheme !== sourceBase.scheme || newBase.authority !== sourceBase.authority) {
          projects.push(project);
          continue;
        }
        let relative: string;
        if (sourceBase.scheme === 'file') {
          relative = path.relative(sourceBase.fsPath, originalUri.fsPath).replace(/\\/gu, '/');
          if (path.isAbsolute(relative)) {
            projects.push(project);
            continue;
          }
        } else {
          relative = path.posix.relative(sourceBase.path, originalUri.path);
        }
        projects.push({ ...project, uri: vscode.Uri.joinPath(newBase, ...relative.split('/')).toString() });
      }
      result.push({ ...catalog, projects });
    }
    return result;
  }
}

function outlineModeChoices(current?: 'native' | 'enhanced' | 'both'): readonly {
  readonly label: string;
  readonly description: string;
  readonly value: 'native' | 'enhanced' | 'both';
}[] {
  return [
    { label: '仅使用增强大纲', description: current === 'enhanced' ? '当前值' : '', value: 'enhanced' },
    { label: '同时使用两个大纲', description: current === 'both' ? '当前值' : '', value: 'both' },
    { label: '仅使用 VS Code 原生大纲', description: current === 'native' ? '当前值' : '', value: 'native' },
  ];
}
