import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildOpenedFilesTree,
  flattenOpenedFileTree,
  OpenedFileDescriptor,
  OpenedFileTreeNode,
} from './openedFilesTreeModel';
import { createTreeIconPath } from '../visual/treeIconResources';
import { getWorkspaceRelativePath } from '../shared/uri';

export class OpenedFilesTreeProvider implements vscode.TreeDataProvider<OpenedFileTreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<OpenedFileTreeNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly collapsedIds = new Set<string>();
  private treeView: vscode.TreeView<OpenedFileTreeNode> | undefined;
  private roots: readonly OpenedFileTreeNode[] = [];
  private readonly parents = new Map<string, OpenedFileTreeNode>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly extensionUri?: vscode.Uri,
  ) {
    this.rebuild();
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleRefresh()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.scheduleRefresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
    );
  }

  public attachTreeView(treeView: vscode.TreeView<OpenedFileTreeNode>): void {
    this.treeView = treeView;
    this.disposables.push(
      treeView.onDidCollapseElement(({ element }) => {
        if (this.collapsedIds.has(element.id)) return;
        setTimeout(() => {
          void treeView.reveal(element, { expand: true, focus: false, select: false }).then(undefined, (error: unknown) => {
            this.output.appendLine(`恢复目录展开状态失败，已降级为下次刷新恢复：${error instanceof Error ? error.message : String(error)}`);
          });
        }, 0);
      }),
      treeView.onDidExpandElement(({ element }) => {
        if (this.collapsedIds.has(element.id)) this.changeEmitter.fire(element);
      }),
    );
  }

  public getTreeItem(node: OpenedFileTreeNode): vscode.TreeItem {
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      if (node.uri !== undefined) item.resourceUri = vscode.Uri.parse(node.uri);
      const description = node.external ? '工作区外' : node.preview ? '预览' : node.active ? '当前' : undefined;
      if (description !== undefined) item.description = description;
      item.contextValue = node.external
        ? 'projectManager.openedFiles.externalFile'
        : 'projectManager.openedFiles.file';
      item.command = {
        command: 'projectManager.focusOpenedFile',
        title: '聚焦已打开文件',
        arguments: [node],
      };
      return item;
    }

    const collapsed = this.collapsedIds.has(node.id);
    const item = new vscode.TreeItem(
      node.label,
      collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = node.id;
    item.contextValue = `projectManager.openedFiles.${node.kind}.${collapsed ? 'collapsed' : 'expanded'}`;
    item.tooltip = `${node.label}\n默认保持展开；使用右键命令折叠或展开。`;
    item.iconPath = node.kind === 'externalGroup' && this.extensionUri !== undefined
      ? createTreeIconPath(this.extensionUri, 'external-file')
      : new vscode.ThemeIcon(node.kind === 'group'
        ? 'layout'
        : node.kind === 'workspace'
          ? 'root-folder'
          : node.kind === 'externalGroup'
            ? 'warning'
            : 'folder');
    return item;
  }

  public getChildren(node?: OpenedFileTreeNode): OpenedFileTreeNode[] {
    if (node === undefined) return [...this.roots];
    if (this.collapsedIds.has(node.id)) return [];
    return [...node.children];
  }

  public getParent(node: OpenedFileTreeNode): OpenedFileTreeNode | undefined {
    return this.parents.get(node.id);
  }

  public refresh(): void {
    this.rebuild();
    this.changeEmitter.fire(undefined);
  }

  public collapse(node: OpenedFileTreeNode): void {
    if (node.kind === 'file') return;
    this.collapsedIds.add(node.id);
    this.changeEmitter.fire(node);
  }

  public expand(node: OpenedFileTreeNode): void {
    this.collapsedIds.delete(node.id);
    this.changeEmitter.fire(node);
  }

  public collapseAll(): void {
    for (const node of flattenOpenedFileTree(this.roots)) {
      if (node.kind !== 'file') this.collapsedIds.add(node.id);
    }
    this.changeEmitter.fire(undefined);
  }

  public expandAll(): void {
    this.collapsedIds.clear();
    this.changeEmitter.fire(undefined);
  }

  public async focusFile(node: OpenedFileTreeNode): Promise<void> {
    if (node.kind !== 'file' || node.uri === undefined || node.groupId === undefined) return;
    const group = vscode.window.tabGroups.all.find((candidate) => String(candidate.viewColumn) === node.groupId);
    const tab = group?.tabs.find((candidate) => getTextUri(candidate)?.toString() === node.uri);
    if (group === undefined || tab === undefined) {
      this.refresh();
      await vscode.window.showInformationMessage('该文件已经关闭，目录树已刷新。');
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.parse(node.uri), {
      viewColumn: group.viewColumn,
      preserveFocus: false,
      preview: tab.isPreview,
    });
  }

  public getRootsForIntegrationTest(): readonly OpenedFileTreeNode[] {
    return this.roots;
  }

  public dispose(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    for (const disposable of this.disposables) disposable.dispose();
    this.changeEmitter.dispose();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, 60);
  }

  private rebuild(): void {
    const groups = vscode.window.tabGroups.all;
    const descriptors: OpenedFileDescriptor[] = [];
    for (const [groupIndex, group] of groups.entries()) {
      for (const tab of group.tabs) {
        const uri = getTextUri(tab);
        if (uri === undefined) continue;
        const workspaceCandidate = vscode.workspace.getWorkspaceFolder(uri);
        const relativePath = workspaceCandidate === undefined
          ? undefined
          : getWorkspaceRelativePath(workspaceCandidate, uri);
        const workspace = relativePath === undefined ? undefined : workspaceCandidate;
        const external = workspace === undefined;
        const displayPath = relativePath ?? path.posix.basename(uri.path);
        descriptors.push({
          id: `${group.viewColumn}:${uri.toString()}`,
          comparisonKey: getUriComparisonKey(uri),
          label: tab.label,
          uri: uri.toString(),
          groupId: String(group.viewColumn),
          groupLabel: `编辑器组 ${groupIndex + 1}`,
          ...(workspace === undefined ? {} : {
            workspaceId: workspace.uri.toString(),
            workspaceLabel: workspace.name,
          }),
          pathSegments: displayPath.split('/').filter(Boolean),
          external,
          active: tab.isActive,
          preview: tab.isPreview,
        });
      }
    }
    this.roots = buildOpenedFilesTree(descriptors);
    this.parents.clear();
    for (const root of this.roots) this.indexParents(root);
    if (this.roots.length === 0 && this.treeView !== undefined) {
      this.treeView.message = '当前没有可显示的已打开普通文件。';
    } else if (this.treeView !== undefined) {
      this.treeView.message = '';
    }
    const uniqueCount = flattenOpenedFileTree(this.roots).filter((node) => node.kind === 'file').length;
    this.output.appendLine(`已打开文件目录已刷新：${uniqueCount} 个文件，来源于 ${descriptors.length} 个普通文件标签。`);
  }

  private indexParents(parent: OpenedFileTreeNode): void {
    for (const child of parent.children) {
      this.parents.set(child.id, parent);
      this.indexParents(child);
    }
  }
}

function getTextUri(tab: vscode.Tab): vscode.Uri | undefined {
  return tab.input instanceof vscode.TabInputText ? tab.input.uri : undefined;
}

export function getUriComparisonKey(uri: vscode.Uri): string {
  if (uri.scheme === 'file') {
    const normalizedPath = path.normalize(uri.fsPath);
    return `file:${process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath}`;
  }

  return uri.with({
    scheme: uri.scheme.toLowerCase(),
    authority: uri.authority.toLowerCase(),
    fragment: '',
  }).toString();
}
