/**
 * 从共享 TodoIndex 构建分类、文件和标记节点；视图范围与筛选不应反向清空底层索引。
 * 分类描述应沿用统一的描述处理规则，不能仅凭相同前缀把不同任务合并。
 * 扫描进度与树重绘频率由注册入口和 todoViewRefreshPolicy 协调，避免每处理一个文件就重建整棵树。
 */
import * as vscode from 'vscode';
import { TodoIndex } from './todoIndex';
import { isMyTodoOwner } from './todoOwner';
import { getTodoSettings } from './todoSettings';
import { formatTodoDescription, todoDescriptionGroupKey } from './todoDescription';
import { TodoGrouping, TodoMatch, TodoResourceResult, TodoScope } from './todoTypes';

export type TodoOwnership = 'mine' | 'other';

interface TodoNodeContext {
  readonly ownership?: TodoOwnership;
  readonly tag?: string;
  readonly descriptionKey?: string;
}

export type TodoTreeNode =
  | { readonly kind: 'ownerGroup'; readonly ownership: TodoOwnership; readonly configured: boolean }
  | { readonly kind: 'category'; readonly descriptionKey: string; readonly label: string; readonly ownership?: TodoOwnership }
  | { readonly kind: 'tag'; readonly tag: string; readonly ownership?: TodoOwnership }
  | { readonly kind: 'result'; readonly resource: TodoResourceResult; readonly match: TodoMatch; readonly grouping: TodoGrouping };

export class TodoTreeProvider implements vscode.TreeDataProvider<TodoTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TodoTreeNode | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;
  public scope: TodoScope = 'workspace';
  public grouping: TodoGrouping = 'category';
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
    if (node?.kind === 'tag') {
      const context: TodoNodeContext = {
        tag: node.tag,
        ...(node.ownership === undefined ? {} : { ownership: node.ownership }),
      };
      return this.resultNodes(this.filteredResources(context), context);
    }
    if (node?.kind === 'category') {
      const context: TodoNodeContext = {
        descriptionKey: node.descriptionKey,
        ...(node.ownership === undefined ? {} : { ownership: node.ownership }),
      };
      return this.resultNodes(this.filteredResources(context), context);
    }
    if (node !== undefined) return [];

    const settings = getTodoSettings();
    const resources = this.filteredResources();
    const mine = this.countMatches(resources, { ownership: 'mine' });
    const other = this.countMatches(resources, { ownership: 'other' });
    if (settings.owner === undefined) {
      return [
        { kind: 'ownerGroup', ownership: 'mine', configured: false },
        ...(!settings.showProjectMarkers || other === 0 ? [] : [{ kind: 'ownerGroup' as const, ownership: 'other' as const, configured: false }]),
      ];
    }
    return [
      { kind: 'ownerGroup', ownership: 'mine', configured: true },
      ...(!settings.showProjectMarkers || other === 0 ? [] : [{ kind: 'ownerGroup' as const, ownership: 'other' as const, configured: true }]),
    ];
  }

  public getTreeItem(node: TodoTreeNode): vscode.TreeItem {
    if (node.kind === 'ownerGroup') {
      const isMine = node.ownership === 'mine';
      const count = this.countMatches(this.filteredResources(), { ownership: node.ownership });
      const item = new vscode.TreeItem(
        isMine ? '我的标记' : '项目已有标记',
        !node.configured && isMine
          ? vscode.TreeItemCollapsibleState.None
          : isMine
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = !node.configured && isMine ? '设置个人标识' : String(count);
      item.iconPath = new vscode.ThemeIcon(isMine ? 'account' : 'repo');
      item.id = `projectManager.todo.owner.${node.ownership}`;
      item.contextValue = `projectManager.todo.ownerGroup.${node.ownership}`;
      if (!node.configured && isMine) {
        item.command = { command: 'projectManager.todo.configureOwner', title: '设置个人标记标识' };
        item.tooltip = '设置后，TODO(个人标识) 会优先显示在“我的标记”中。';
      }
      return item;
    }
    if (node.kind === 'tag') {
      const count = this.countMatches(this.filteredResources(node), node);
      const item = new vscode.TreeItem(node.tag, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(count);
      item.iconPath = this.tagIcon(node.tag);
      item.id = `projectManager.todo.tag.${node.ownership ?? 'all'}.${node.tag}`;
      return item;
    }
    if (node.kind === 'category') {
      const count = this.countMatches(this.filteredResources(node), node);
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(count);
      item.iconPath = new vscode.ThemeIcon('list-tree');
      item.id = `projectManager.todo.description.${node.ownership ?? 'all'}.${node.descriptionKey}`;
      return item;
    }
    const fileName = node.resource.relativePath.split('/').pop() ?? node.resource.relativePath;
    const location = `${fileName}:${node.match.line + 1}`;
    const label = node.grouping === 'category' ? location : formatTodoDescription(node.match.text);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = node.grouping === 'category' ? node.match.tag : `${node.match.tag} · ${location}`;
    item.iconPath = this.tagIcon(node.match.tag);
    const mine = isMyTodoOwner(node.match.owner, getTodoSettings().ownerIdentities);
    item.contextValue = `projectManager.todo.result.${mine ? 'mine' : 'other'}`;
    item.command = { command: 'projectManager.todo.open', title: '打开 TODO', arguments: [node] };
    const owner = node.match.owner === undefined ? '未分配' : node.match.owner;
    const fullDescription = node.match.text.trim().length === 0 ? '未填写描述' : node.match.text.trim();
    item.tooltip = `${fullDescription}\n类型：${node.match.tag}\n负责人：${owner}\n${node.resource.relativePath}:${node.match.line + 1}`;
    return item;
  }

  public dispose(): void { this.emitter.dispose(); }

  private groupedNodes(resources: readonly TodoResourceResult[], context: TodoNodeContext): TodoTreeNode[] {
    if (this.grouping === 'tag' && context.tag === undefined) {
      return [...new Set(resources.flatMap((entry) => this.visibleMatches(entry, context).map((match) => match.tag)))]
        .sort()
        .map((tag) => ({ kind: 'tag', tag, ...(context.ownership === undefined ? {} : { ownership: context.ownership }) }));
    }
    return [...new Set(resources.flatMap((entry) => this.visibleMatches(entry, context)
      .map((match) => todoDescriptionGroupKey(match.text))))]
      .sort((left, right) => formatTodoDescription(left).localeCompare(formatTodoDescription(right), 'zh-CN', { numeric: true })
        || left.localeCompare(right, 'zh-CN', { numeric: true }))
      .map((descriptionKey) => ({
        kind: 'category' as const,
        descriptionKey,
        label: formatTodoDescription(descriptionKey),
        ...(context.ownership === undefined ? {} : { ownership: context.ownership }),
      }));
  }

  private filteredResources(context: TodoNodeContext = {}): TodoResourceResult[] {
    return this.index.values().filter((entry) => this.visibleMatches(entry, context).length > 0);
  }

  private resultNodes(resources: readonly TodoResourceResult[], context: TodoNodeContext): TodoTreeNode[] {
    return resources
      .flatMap((resource) => this.visibleMatches(resource, context).map((match) => ({
        kind: 'result' as const,
        resource,
        match,
        grouping: this.grouping,
      })))
      .sort((left, right) => formatTodoDescription(left.match.text).localeCompare(formatTodoDescription(right.match.text), 'zh-CN', { numeric: true })
        || left.resource.relativePath.localeCompare(right.resource.relativePath, 'zh-CN', { numeric: true })
        || left.match.line - right.match.line);
  }

  private countMatches(resources: readonly TodoResourceResult[], context: TodoNodeContext = {}): number {
    return resources.reduce((sum, resource) => sum + this.visibleMatches(resource, context).length, 0);
  }

  private visibleMatches(resource: TodoResourceResult, context: TodoNodeContext): TodoMatch[] {
    const identities = getTodoSettings().ownerIdentities;
    return resource.matches
      .filter((match) => context.tag === undefined || match.tag === context.tag)
      .filter((match) => context.descriptionKey === undefined
        || todoDescriptionGroupKey(match.text) === context.descriptionKey)
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
