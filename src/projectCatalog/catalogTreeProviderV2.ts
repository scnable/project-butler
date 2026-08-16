import * as vscode from 'vscode';
import { ProjectCatalogServiceV2, ResolvedCatalogProject } from './catalogServiceV2';
import { IconSemantic } from '../visual/iconSemantics';
import { createTreeIconPath } from '../visual/treeIconResources';

interface CatalogSummaryNode { readonly kind: 'summary' }
interface CatalogContextNode { readonly kind: 'context' }
interface LegacyMigrationNode { readonly kind: 'legacyMigration' }

export type ProjectCatalogTreeNodeV2 = ResolvedCatalogProject | CatalogSummaryNode | CatalogContextNode | LegacyMigrationNode;

export class ProjectCatalogTreeProviderV2 implements vscode.TreeDataProvider<ProjectCatalogTreeNodeV2>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ProjectCatalogTreeNodeV2 | undefined>();
  private readonly subscriptions: vscode.Disposable[];
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(
    private readonly service: ProjectCatalogServiceV2,
    private readonly extensionUri?: vscode.Uri,
  ) {
    this.subscriptions = [service.onDidChange(() => this.changeEmitter.fire(undefined))];
  }

  public getChildren(): ProjectCatalogTreeNodeV2[] {
    const catalog = this.service.current;
    if (catalog === undefined) {
      return this.service.hasLegacyCatalogToImport ? [{ kind: 'legacyMigration' }] : [];
    }
    return [{ kind: 'summary' }, { kind: 'context' }, ...catalog.projects];
  }

  public getTreeItem(node: ProjectCatalogTreeNodeV2): vscode.TreeItem {
    if ('kind' in node) {
      if (node.kind === 'legacyMigration') {
        const item = new vscode.TreeItem('导入旧项目集合', vscode.TreeItemCollapsibleState.None);
        item.description = '检测到开发期集合文件';
        item.iconPath = new vscode.ThemeIcon('cloud-download', new vscode.ThemeColor('charts.orange'));
        item.command = { command: 'projectManager.importLegacyCatalog', title: '导入旧项目集合' };
        item.tooltip = '导入后集合由插件内部管理，原文件保持不变，也不会继续被监听。';
        return item;
      }
      if (node.kind === 'summary') {
        const catalog = this.service.current;
        const item = new vscode.TreeItem(catalog?.name ?? '项目集合', vscode.TreeItemCollapsibleState.None);
        item.description = catalog === undefined ? '' : `${catalog.projects.length} 个项目 · 内部存储`;
        item.iconPath = this.iconPath('catalog', 'library');
        item.contextValue = 'projectCatalog.summary';
        item.command = { command: 'projectManager.selectCatalog', title: '切换项目集合' };
        item.tooltip = `当前集合由插件内部管理。\n配置修订：${this.service.configurationRevision}\n点击切换其他集合。`;
        return item;
      }
      return this.createContextItem();
    }
    const item = new vscode.TreeItem(node.alias, vscode.TreeItemCollapsibleState.None);
    item.description = node.description ?? node.path;
    item.iconPath = node.available
      ? node.type === 'workspace'
        ? this.iconPath('workspace', 'window')
        : this.iconPath('project', 'root-folder')
      : node.type === 'workspace'
        ? this.iconPath('project.unavailable.workspace', 'warning')
        : this.iconPath('project.unavailable.folder', 'warning');
    item.contextValue = node.available ? 'projectCatalog.availableProject' : 'projectCatalog.invalidProject';
    item.command = { command: 'projectManager.openProject', title: '打开项目', arguments: [node] };
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${escapeMarkdown(node.alias)}**\n\n`);
    tooltip.appendMarkdown(`位置：\`${escapeMarkdown(node.path)}\`\n\n`);
    tooltip.appendMarkdown(`类型：${node.type === 'workspace' ? 'VS Code 工作区' : '文件夹'}\n\n`);
    if (node.description !== undefined) tooltip.appendMarkdown(`说明：${escapeMarkdown(node.description)}\n\n`);
    if (node.tags.length > 0) tooltip.appendMarkdown(`标签：${node.tags.map((tag) => `\`${escapeMarkdown(tag)}\``).join(' ')}\n\n`);
    if (node.runtimeIssue !== undefined) tooltip.appendMarkdown(`$(warning) ${escapeMarkdown(node.runtimeIssue)}`);
    item.tooltip = tooltip;
    return item;
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changeEmitter.dispose();
  }

  private createContextItem(): vscode.TreeItem {
    const context = this.service.projectContext;
    if (context.kind === 'member') {
      const item = new vscode.TreeItem(`当前项目：${context.project.alias}`, vscode.TreeItemCollapsibleState.None);
      item.description = '集合内 · 使用集合功能配置';
      item.iconPath = this.iconPath('context.member', 'pass-filled');
      return item;
    }
    if (context.kind === 'external') {
      const item = new vscode.TreeItem('当前项目：集合外项目', vscode.TreeItemCollapsibleState.None);
      item.description = '使用个人默认配置';
      item.iconPath = this.iconPath('context.external', 'circle-slash');
      return item;
    }
    const item = new vscode.TreeItem('当前窗口：未打开工作区', vscode.TreeItemCollapsibleState.None);
    item.description = '可选择集合并打开项目';
    item.iconPath = this.iconPath('context.empty', 'window');
    return item;
  }

  private iconPath(
    semantic: IconSemantic,
    fallback: string,
  ): vscode.ThemeIcon | ReturnType<typeof createTreeIconPath> {
    return this.extensionUri === undefined
      ? new vscode.ThemeIcon(fallback)
      : createTreeIconPath(this.extensionUri, semantic);
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!]/gu, '\\$&');
}
