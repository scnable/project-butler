import * as vscode from 'vscode';
import { TodoIndex } from './todoIndex';
import { isMyTodoOwner } from './todoOwner';
import { getTodoSettings } from './todoSettings';
import { buildTodoHierarchy } from './todoTreeModel';
import { TodoGrouping, TodoMatch, TodoResourceResult, TodoScope } from './todoTypes';

export type TodoOwnership = 'mine' | 'other';

interface TodoNodeContext {
  readonly ownership?: TodoOwnership;
  readonly tag?: string;
}

export type TodoTreeNode =
  | { readonly kind: 'ownerGroup'; readonly ownership: TodoOwnership; readonly configured: boolean }
  | { readonly kind: 'workspace'; readonly uri: string; readonly label: string; readonly ownership?: TodoOwnership; readonly tag?: string }
  | { readonly kind: 'tag'; readonly tag: string; readonly ownership?: TodoOwnership }
  | { readonly kind: 'directory'; readonly path: string; readonly label: string; readonly resources: readonly TodoResourceResult[]; readonly ownership?: TodoOwnership; readonly tag?: string }
  | { readonly kind: 'file'; readonly resource: TodoResourceResult; readonly ownership?: TodoOwnership; readonly tag?: string }
  | { readonly kind: 'result'; readonly resource: TodoResourceResult; readonly match: TodoMatch };

export class TodoTreeProvider implements vscode.TreeDataProvider<TodoTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TodoTreeNode | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;
  public scope: TodoScope = 'workspace';
  public grouping: TodoGrouping = 'file';
  public filter = '';

  public constructor(public readonly index: TodoIndex) {}

  public refresh(): void { this.emitter.fire(undefined); }

  public get totalResultCount(): number {
    return this.index.values().reduce((sum, entry) => sum + entry.matches.length, 0);
  }

  public get visibleResultCount(): number {
    return this.countMatches(this.index.values());
  }

  public getChildren(node?: TodoTreeNode): TodoTreeNode[] {
    if (node?.kind === 'ownerGroup') {
      if (!node.configured && node.ownership === 'mine') return [];
      return this.groupedNodes(this.filteredResources({ ownership: node.ownership }), { ownership: node.ownership });
    }
    if (node?.kind === 'workspace') {
      return this.hierarchyNodes(
        this.filteredResources(node).filter((entry) => entry.workspaceUri === node.uri),
        '',
        node,
      );
    }
    if (node?.kind === 'tag') {
      const context: TodoNodeContext = {
        tag: node.tag,
        ...(node.ownership === undefined ? {} : { ownership: node.ownership }),
      };
      return this.workspaceOrHierarchy(this.filteredResources(context), context);
    }
    if (node?.kind === 'directory') return this.hierarchyNodes(node.resources, node.path, node);
    if (node?.kind === 'file') {
      return this.visibleMatches(node.resource, node)
        .map((match) => ({ kind: 'result', resource: node.resource, match }));
    }
    if (node !== undefined) return [];

    const settings = getTodoSettings();
    const resources = this.filteredResources();
    const mine = this.countMatches(resources, { ownership: 'mine' });
    const other = this.countMatches(resources, { ownership: 'other' });
    if (settings.owner === undefined) {
      return [
        { kind: 'ownerGroup', ownership: 'mine', configured: false },
        ...(other === 0 ? [] : [{ kind: 'ownerGroup' as const, ownership: 'other' as const, configured: false }]),
      ];
    }
    return [
      { kind: 'ownerGroup', ownership: 'mine', configured: true },
      ...(other === 0 ? [] : [{ kind: 'ownerGroup' as const, ownership: 'other' as const, configured: true }]),
    ];
  }

  public getTreeItem(node: TodoTreeNode): vscode.TreeItem {
    if (node.kind === 'ownerGroup') {
      const isMine = node.ownership === 'mine';
      const count = this.countMatches(this.filteredResources(), { ownership: node.ownership });
      const item = new vscode.TreeItem(
        isMine ? '我的标记' : '项目其他标记',
        !node.configured && isMine
          ? vscode.TreeItemCollapsibleState.None
          : isMine
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = !node.configured && isMine ? '设置个人标识' : String(count);
      item.iconPath = new vscode.ThemeIcon(isMine ? 'account' : 'repo');
      item.contextValue = `projectManager.todo.ownerGroup.${node.ownership}`;
      if (!node.configured && isMine) {
        item.command = { command: 'projectManager.todo.configureOwner', title: '设置个人标记标识' };
        item.tooltip = '设置后，TODO(个人标识) 会优先显示在“我的标记”中。';
      }
      return item;
    }
    if (node.kind === 'workspace') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('root-folder');
      return item;
    }
    if (node.kind === 'tag') {
      const count = this.countMatches(this.filteredResources(node), node);
      const item = new vscode.TreeItem(node.tag, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(count);
      item.iconPath = this.tagIcon(node.tag);
      return item;
    }
    if (node.kind === 'directory') {
      const count = this.countMatches(node.resources, node);
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(count);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.tooltip = `${node.path} · ${count} 条标记`;
      return item;
    }
    if (node.kind === 'file') {
      const count = this.visibleMatches(node.resource, node).length;
      const item = new vscode.TreeItem(node.resource.relativePath.split('/').pop() ?? node.resource.relativePath, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(count);
      item.tooltip = `${node.resource.relativePath} · ${count} 条标记`;
      item.resourceUri = vscode.Uri.parse(node.resource.uri);
      return item;
    }
    const label = node.match.text.length === 0 ? node.match.tag : node.match.text;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = `${node.match.tag} · ${node.match.line + 1}`;
    item.iconPath = this.tagIcon(node.match.tag);
    const mine = isMyTodoOwner(node.match.owner, getTodoSettings().ownerIdentities);
    item.contextValue = `projectManager.todo.result.${mine ? 'mine' : 'other'}`;
    item.command = { command: 'projectManager.todo.open', title: '打开 TODO', arguments: [node] };
    const owner = node.match.owner === undefined ? '未分配' : node.match.owner;
    item.tooltip = `${node.match.tag}: ${node.match.text}\n负责人：${owner}\n${node.resource.relativePath}:${node.match.line + 1}`;
    return item;
  }

  public dispose(): void { this.emitter.dispose(); }

  private groupedNodes(resources: readonly TodoResourceResult[], context: TodoNodeContext): TodoTreeNode[] {
    if (this.grouping === 'tag' && context.tag === undefined) {
      return [...new Set(resources.flatMap((entry) => this.visibleMatches(entry, context).map((match) => match.tag)))]
        .sort()
        .map((tag) => ({ kind: 'tag', tag, ...(context.ownership === undefined ? {} : { ownership: context.ownership }) }));
    }
    return this.workspaceOrHierarchy(resources, context);
  }

  private workspaceOrHierarchy(resources: readonly TodoResourceResult[], context: TodoNodeContext): TodoTreeNode[] {
    const workspaceUris = [...new Set(resources.map((entry) => entry.workspaceUri).filter((uri): uri is string => uri !== undefined))];
    if (workspaceUris.length <= 1) return this.hierarchyNodes(resources, '', context);
    return workspaceUris.map((uri) => ({
      kind: 'workspace',
      uri,
      label: vscode.workspace.workspaceFolders?.find((folder) => folder.uri.toString() === uri)?.name ?? uri,
      ...(context.ownership === undefined ? {} : { ownership: context.ownership }),
      ...(context.tag === undefined ? {} : { tag: context.tag }),
    }));
  }

  private filteredResources(context: TodoNodeContext = {}): TodoResourceResult[] {
    return this.index.values().filter((entry) => this.visibleMatches(entry, context).length > 0);
  }

  private hierarchyNodes(
    resources: readonly TodoResourceResult[],
    parentPath = '',
    context: TodoNodeContext = {},
  ): TodoTreeNode[] {
    const hierarchy = buildTodoHierarchy(resources, parentPath);
    const directoryNodes: TodoTreeNode[] = hierarchy.directories.map((directory) => ({
      kind: 'directory',
      label: directory.label,
      path: directory.path,
      resources: directory.resources,
      ...(context.ownership === undefined ? {} : { ownership: context.ownership }),
      ...(context.tag === undefined ? {} : { tag: context.tag }),
    }));
    const fileNodes: TodoTreeNode[] = hierarchy.files.map((resource) => ({
      kind: 'file',
      resource,
      ...(context.ownership === undefined ? {} : { ownership: context.ownership }),
      ...(context.tag === undefined ? {} : { tag: context.tag }),
    }));
    return [...directoryNodes, ...fileNodes];
  }

  private countMatches(resources: readonly TodoResourceResult[], context: TodoNodeContext = {}): number {
    return resources.reduce((sum, resource) => sum + this.visibleMatches(resource, context).length, 0);
  }

  private visibleMatches(resource: TodoResourceResult, context: TodoNodeContext): TodoMatch[] {
    const identities = getTodoSettings().ownerIdentities;
    return resource.matches
      .filter((match) => context.tag === undefined || match.tag === context.tag)
      .filter((match) => context.ownership === undefined
        || (context.ownership === 'mine') === isMyTodoOwner(match.owner, identities))
      .filter((match) => this.matchesFilter(resource, match));
  }

  private matchesFilter(resource: TodoResourceResult, match: TodoMatch): boolean {
    const filter = this.filter.trim().toLocaleLowerCase();
    return filter.length === 0 || `${match.tag} ${match.owner ?? ''} ${match.text} ${resource.relativePath}`.toLocaleLowerCase().includes(filter);
  }

  private tagIcon(tag: string): vscode.ThemeIcon {
    const definition = getTodoSettings().tags.find((item) => item.name === tag);
    return new vscode.ThemeIcon(definition?.icon ?? 'check');
  }
}
