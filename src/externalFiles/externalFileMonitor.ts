import * as path from 'node:path';
import * as vscode from 'vscode';
import { getUriDisplayPath } from '../shared/uri';

interface ExternalFileQuickPickItem extends vscode.QuickPickItem {
  readonly uri: vscode.Uri;
}

export class ExternalFileMonitor implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly decorationEmitter = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  private readonly statusBarItem: vscode.StatusBarItem;

  public readonly onDidChangeFileDecorations = this.decorationEmitter.event;

  public constructor(private readonly output: vscode.OutputChannel) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'projectManager.externalFile',
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBarItem.name = '项目管家：工作区外文件';
    this.statusBarItem.command = 'projectManager.showExternalFiles';

    this.disposables.push(
      this.decorationEmitter,
      this.statusBarItem,
      vscode.window.registerFileDecorationProvider(this),
      vscode.workspace.onDidOpenTextDocument((document) => this.handleDocumentOpened(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.refresh([document.uri])),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshAll()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('projectManager.externalFiles')) {
          this.refreshAll();
        }
      }),
    );

    this.refreshAll();
  }

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.isExternalFile(uri)) {
      return undefined;
    }

    const configuration = vscode.workspace.getConfiguration('projectManager.externalFiles');
    const showBadge = configuration.get<boolean>('showBadge', true);
    const showColor = configuration.get<boolean>('showColor', true);
    const decoration = new vscode.FileDecoration(
      showBadge ? '‼' : undefined,
      `‼ 工作区外文件：${getUriDisplayPath(uri)}`,
      showColor ? new vscode.ThemeColor('projectManager.externalFileForeground') : undefined,
    );
    decoration.propagate = false;
    return decoration;
  }

  public getOpenExternalFiles(): readonly vscode.Uri[] {
    const unique = new Map<string, vscode.Uri>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && this.isExternalFile(tab.input.uri)) {
          unique.set(tab.input.uri.toString(), tab.input.uri);
        }
      }
    }
    return [...unique.values()];
  }

  public isExternalFileForIntegrationTest(uri: vscode.Uri): boolean {
    return this.isExternalFile(uri);
  }

  public getStatusBarStateForIntegrationTest(): {
    readonly text: string;
    readonly tooltip: string | vscode.MarkdownString | undefined;
    readonly backgroundColor: vscode.ThemeColor | undefined;
  } {
    return {
      text: this.statusBarItem.text,
      tooltip: this.statusBarItem.tooltip,
      backgroundColor: this.statusBarItem.backgroundColor,
    };
  }

  public async showOpenExternalFiles(): Promise<void> {
    const files = this.getOpenExternalFiles();
    if (files.length === 0) {
      await vscode.window.showInformationMessage('当前没有打开的工作区外文件。');
      return;
    }

    const items: ExternalFileQuickPickItem[] = files.map((uri) => ({
      label: `$(warning) ${path.posix.basename(uri.path)}`,
      description: getUriDisplayPath(uri),
      detail: '该文件不属于当前工作区',
      uri,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要打开的工作区外文件',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (selected !== undefined) {
      await vscode.window.showTextDocument(selected.uri, { preview: false });
    }
  }

  public async diagnoseActiveFile(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri === undefined) {
      await vscode.window.showInformationMessage('当前编辑器不是普通文本文件。');
      return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    const owningFolder = vscode.workspace.getWorkspaceFolder(uri);
    const enabled = vscode.workspace
      .getConfiguration('projectManager.externalFiles')
      .get<boolean>('enabled', true);
    const external = this.isExternalFile(uri);
    const result = external
      ? '判定结果：工作区外文件'
      : owningFolder !== undefined
        ? `判定结果：工作区内文件，所属根目录为“${owningFolder.name}”`
        : '判定结果：未标记（功能已关闭、没有工作区或不是可识别的文件 URI）';
    const details = [
      result,
      `文件：${getUriDisplayPath(uri)}`,
      `外部文件功能：${enabled ? '已启用' : '已关闭'}`,
      `工作区根目录：${folders.length > 0 ? folders.map((folder) => getUriDisplayPath(folder.uri)).join('；') : '无'}`,
    ].join('\n');

    this.output.appendLine(`[诊断]\n${details}`);
    await vscode.window.showInformationMessage(result, { modal: true, detail: details });
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private isExternalFile(uri: vscode.Uri): boolean {
    const configuration = vscode.workspace.getConfiguration('projectManager.externalFiles');
    if (!configuration.get<boolean>('enabled', true)) {
      return false;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined || folders.length === 0 || !this.isFileLikeUri(uri, folders)) {
      return false;
    }

    return vscode.workspace.getWorkspaceFolder(uri) === undefined;
  }

  private isFileLikeUri(
    uri: vscode.Uri,
    folders: readonly vscode.WorkspaceFolder[],
  ): boolean {
    if (uri.scheme === 'file') {
      return true;
    }

    return folders.some(
      (folder) => folder.uri.scheme === uri.scheme && folder.uri.authority === uri.authority,
    );
  }

  private refresh(uris: readonly vscode.Uri[]): void {
    if (uris.length > 0) {
      this.decorationEmitter.fire([...uris]);
    }
    this.updateStatusBar();
  }

  private handleDocumentOpened(document: vscode.TextDocument): void {
    this.refresh([document.uri]);
    if (this.isExternalFile(document.uri)) {
      this.output.appendLine(`[外部文件] 已识别: ${getUriDisplayPath(document.uri)}`);
    }
  }

  private refreshAll(): void {
    const uris = vscode.workspace.textDocuments.map((document) => document.uri);
    this.decorationEmitter.fire([...uris]);
    this.updateStatusBar();
    this.output.appendLine(`[外部文件] 当前打开 ${this.getOpenExternalFiles().length} 个工作区外文件。`);
  }

  private updateStatusBar(): void {
    const configuration = vscode.workspace.getConfiguration('projectManager.externalFiles');
    const activeUri = vscode.window.activeTextEditor?.document.uri;

    const activeFileIsExternal = activeUri !== undefined && this.isExternalFile(activeUri);
    void vscode.commands.executeCommand(
      'setContext',
      'projectManager.activeFileIsExternal',
      activeFileIsExternal,
    );

    if (
      !configuration.get<boolean>('showStatusBar', true)
      || activeUri === undefined
      || !activeFileIsExternal
    ) {
      this.statusBarItem.hide();
      return;
    }

    const externalCount = this.getOpenExternalFiles().length;
    const fileName = path.posix.basename(activeUri.path);
    this.statusBarItem.text = `$(warning) 工作区外：${fileName}${externalCount > 1 ? ` (${externalCount})` : ''}`;
    this.statusBarItem.tooltip = `当前文件不属于工作区：${getUriDisplayPath(activeUri)}\n点击查看全部工作区外文件。`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.statusBarItem.show();
  }
}
