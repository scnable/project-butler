import * as path from 'node:path';
import * as vscode from 'vscode';
import { inferProjectType } from './catalogModel';
import {
  ActiveProjectCatalog,
  CatalogTabSettingKey,
  ProjectCatalogService,
  ResolvedCatalogProject,
} from './catalogService';
import { resolveEffectiveTabSettings } from '../tabManagement/tabSettings';
import { resolveEffectiveOutlineMode } from '../symbolOutline/outlineSettings';

interface CatalogSourceNode {
  readonly kind: 'source';
}

interface CatalogSettingsGroupNode {
  readonly kind: 'settingsGroup';
}

interface CatalogContextNode {
  readonly kind: 'context';
}

interface CatalogOutlineSettingsGroupNode {
  readonly kind: 'outlineSettingsGroup';
}

interface CatalogOutlineSettingNode {
  readonly kind: 'outlineSetting';
}

interface CatalogSettingNode {
  readonly kind: 'setting';
  readonly key: CatalogTabSettingKey;
}

interface CatalogTabActionNode {
  readonly kind: 'tabAction';
  readonly action: 'organizeCurrentGroup';
}

export type ProjectCatalogTreeNode = ResolvedCatalogProject
  | CatalogSourceNode
  | CatalogContextNode
  | CatalogSettingsGroupNode
  | CatalogOutlineSettingsGroupNode
  | CatalogOutlineSettingNode
  | CatalogSettingNode
  | CatalogTabActionNode;

export class ProjectCatalogTreeProvider implements vscode.TreeDataProvider<ProjectCatalogTreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ProjectCatalogTreeNode | undefined>();
  private readonly subscriptions: vscode.Disposable[];
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly service: ProjectCatalogService) {
    this.subscriptions = [
      service.onDidChange(() => this.changeEmitter.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('projectManager.tabs')
          || event.affectsConfiguration('projectManager.symbolOutline.mode')) {
          this.changeEmitter.fire(undefined);
        }
      }),
    ];
  }

  public getTreeItem(node: ProjectCatalogTreeNode): vscode.TreeItem {
    if ('kind' in node) {
      return this.getSpecialTreeItem(node);
    }
    const project = node;
    const item = new vscode.TreeItem(project.alias, vscode.TreeItemCollapsibleState.None);
    const inferredType = inferProjectType(project.path, project.type);
    item.description = project.description ?? project.path;
    item.iconPath = getProjectIcon(project.available, inferredType);
    item.contextValue = project.available ? 'projectCatalog.availableProject' : 'projectCatalog.invalidProject';
    item.tooltip = this.createTooltip(project, inferredType);
    item.command = {
      command: 'projectManager.openProject',
      title: project.available ? '打开项目' : '查看项目问题',
      arguments: [project],
    };
    return item;
  }

  public getChildren(node?: ProjectCatalogTreeNode): ProjectCatalogTreeNode[] {
    const catalog = this.service.current;
    if (catalog === undefined) {
      return [];
    }
    if (node === undefined) {
      return [
        { kind: 'source' },
        { kind: 'context' },
        { kind: 'settingsGroup' },
        { kind: 'outlineSettingsGroup' },
        ...catalog.projects,
      ];
    }
    if ('kind' in node && node.kind === 'settingsGroup') {
      return [
        { kind: 'tabAction', action: 'organizeCurrentGroup' },
        { kind: 'setting', key: 'autoOrganize' },
      ];
    }
    if ('kind' in node && node.kind === 'outlineSettingsGroup') {
      return [];
    }
    return [];
  }

  public getParent(): undefined {
    return undefined;
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.changeEmitter.dispose();
  }

  private getSpecialTreeItem(
    node: CatalogSourceNode | CatalogContextNode | CatalogSettingsGroupNode | CatalogOutlineSettingsGroupNode | CatalogOutlineSettingNode | CatalogSettingNode | CatalogTabActionNode,
  ): vscode.TreeItem {
    const active = this.service.current;
    if (node.kind === 'source') {
      const fileName = active === undefined ? '项目集合配置文件' : path.posix.basename(active.uri.path);
      const displayName = active?.catalog.name ?? fileName;
      const item = new vscode.TreeItem(displayName, vscode.TreeItemCollapsibleState.None);
      item.description = active === undefined
        ? ''
        : `${active.catalog.name === undefined ? '' : `${fileName} · `}${getCompatibilityLabel(active)} · ${active.projects.length} 个项目`;
      item.iconPath = active?.catalog.compatibility === 'current'
        ? new vscode.ThemeIcon('json', new vscode.ThemeColor('charts.orange'))
        : new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      item.contextValue = 'projectCatalog.source';
      item.command = {
        command: 'projectManager.openCatalogSource',
        title: '打开项目集合配置文件',
      };
      if (active !== undefined) {
        item.tooltip = `当前项目集合配置文件\n${active.uri.fsPath || active.uri.toString()}`;
      }
      return item;
    }
    if (node.kind === 'context') {
      const context = this.service.projectContext;
      if (context.kind === 'member') {
        const item = new vscode.TreeItem(`当前项目：${context.project.alias}`, vscode.TreeItemCollapsibleState.None);
        item.description = '集合内项目 · 使用集合功能配置';
        item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
        item.contextValue = 'projectCatalog.context.member';
        item.tooltip = `当前工作区属于活动集合中的“${context.project.alias}”。\n集合功能配置可以在此项目中生效。`;
        return item;
      }
      if (context.kind === 'external') {
        const item = new vscode.TreeItem('当前项目：集合外项目', vscode.TreeItemCollapsibleState.None);
        item.description = '不使用集合功能配置';
        item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
        item.contextValue = 'projectCatalog.context.external';
        item.tooltip = '当前工作区不属于活动集合。仍可管理和打开集合项目，但集合功能配置不会应用到当前工作区。';
        return item;
      }
      const item = new vscode.TreeItem('当前窗口：集合启动窗口', vscode.TreeItemCollapsibleState.None);
      item.description = '未打开工作区';
      item.iconPath = new vscode.ThemeIcon('window', new vscode.ThemeColor('charts.purple'));
      item.contextValue = 'projectCatalog.context.noWorkspace';
      item.tooltip = '当前没有打开文件夹或工作区，可从下方选择项目。项目型功能配置暂不应用。';
      return item;
    }
    if (node.kind === 'settingsGroup') {
      const item = new vscode.TreeItem('标签页设置', vscode.TreeItemCollapsibleState.Expanded);
      const effective = resolveEffectiveTabSettings(this.service.currentProjectTabSettings);
      item.iconPath = new vscode.ThemeIcon('layout', new vscode.ThemeColor('charts.blue'));
      item.description = `非项目标签移至末尾${effective.values.autoOrganize ? '已开启' : '已关闭'} · ${effective.sources.autoOrganize}`;
      item.contextValue = 'projectCatalog.tabSettings';
      return item;
    }
    if (node.kind === 'outlineSettingsGroup') {
      const effective = resolveEffectiveOutlineMode(this.service.currentProjectSymbolOutlineSettings);
      const shared = active?.catalog.features.symbolOutline.mode ?? 'both';
      const item = new vscode.TreeItem('函数大纲模式', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.purple'));
      item.description = this.service.projectContext.kind === 'member'
        ? `${formatOutlineMode(effective.mode)} · ${effective.source}`
        : `${formatOutlineMode(shared)} · 集合共享值`;
      item.contextValue = 'projectCatalog.outlineSettings';
      item.command = {
        command: 'projectManager.configureCatalogOutlineMode',
        title: '修改集合函数大纲模式',
      };
      item.tooltip = `点击修改当前集合文件中的 features.symbolOutline.mode。\n集合共享值：${formatOutlineMode(shared)}\n当前窗口：${formatContextKind(this.service.projectContext.kind)}\n${this.service.projectContext.kind === 'member' ? `当前生效：${formatOutlineMode(effective.mode)}（${effective.source}）` : '当前窗口不应用集合功能配置；打开集合内项目后生效。'}`;
      return item;
    }
    if (node.kind === 'outlineSetting') {
      const effective = resolveEffectiveOutlineMode(this.service.currentProjectSymbolOutlineSettings);
      const shared = active?.catalog.features.symbolOutline.mode ?? 'both';
      const item = new vscode.TreeItem('大纲模式', vscode.TreeItemCollapsibleState.None);
      item.description = `${formatOutlineMode(effective.mode)} · ${effective.source}`;
      item.iconPath = new vscode.ThemeIcon('list-tree', new vscode.ThemeColor('charts.purple'));
      item.contextValue = 'projectCatalog.outlineSetting.mode';
      item.command = {
        command: 'projectManager.selectSymbolOutlineMode',
        title: '选择函数大纲模式',
      };
      item.tooltip = `点击直接选择“仅原生”“仅增强”或“同时使用”。\n当前生效：${formatOutlineMode(effective.mode)}（${effective.source}）\n集合默认：${formatOutlineMode(shared)}\n当前归属：${formatContextKind(this.service.projectContext.kind)}\n如需修改可迁移默认值，请打开集合配置文件并编辑 features.symbolOutline.mode。`;
      return item;
    }
    if (node.kind === 'tabAction') {
      const item = new vscode.TreeItem(
        '手动将非项目标签移到末尾',
        vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon('list-tree', new vscode.ThemeColor('charts.blue'));
      item.contextValue = `projectCatalog.tabAction.${node.action}`;
      item.command = {
        command: 'projectManager.organizeCurrentTabGroup',
        title: '手动将非项目标签移到末尾',
      };
      item.tooltip = '稳定地把工作区外文件及非项目标签移到当前编辑器组末尾，不改变项目内文件之间的顺序。';
      return item;
    }

    const effective = resolveEffectiveTabSettings(this.service.currentProjectTabSettings);
    const item = new vscode.TreeItem(getSettingLabel(node.key), vscode.TreeItemCollapsibleState.None);
    item.description = getSettingDescription(node.key, effective);
    item.iconPath = effective.values.autoOrganize
      ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
    item.contextValue = `projectCatalog.tabSetting.${node.key}`;
    item.command = {
      command: 'projectManager.configureCatalogTabSetting',
      title: '修改标签页设置',
      arguments: [node.key],
    };
    item.tooltip = getSettingTooltip(node.key, active, effective, this.service.projectContext.kind);
    return item;
  }

  private createTooltip(project: ResolvedCatalogProject, type: 'folder' | 'workspace'): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${escapeMarkdown(project.alias)}**\n\n`);
    tooltip.appendMarkdown(`路径：\`${escapeMarkdown(project.path)}\`\n\n`);
    tooltip.appendMarkdown(`类型：${type === 'workspace' ? 'VS Code 工作区' : '文件夹'}\n\n`);
    if (project.description !== undefined) {
      tooltip.appendMarkdown(`${escapeMarkdown(project.description)}\n\n`);
    }
    if (project.tags.length > 0) {
      tooltip.appendMarkdown(`标签：${project.tags.map((tag) => `\`${escapeMarkdown(tag)}\``).join(' ')}\n\n`);
    }
    const issueMessages = [
      ...project.issues.map((issue) => issue.message),
      ...(project.runtimeIssue === undefined ? [] : [project.runtimeIssue]),
    ];
    if (issueMessages.length > 0) {
      tooltip.appendMarkdown(`$(warning) ${issueMessages.map(escapeMarkdown).join('；')}`);
    }
    return tooltip;
  }
}

function getProjectIcon(available: boolean, type: 'folder' | 'workspace'): vscode.ThemeIcon {
  if (!available) {
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
  }
  return type === 'workspace'
    ? new vscode.ThemeIcon('window', new vscode.ThemeColor('charts.purple'))
    : new vscode.ThemeIcon('root-folder', new vscode.ThemeColor('charts.blue'));
}

function getCompatibilityLabel(catalog: ActiveProjectCatalog): string {
  const version = catalog.catalog.schemaVersion === undefined ? '未知版本' : `v${catalog.catalog.schemaVersion}`;
  switch (catalog.catalog.compatibility) {
    case 'current': return `${version} · 当前版本`;
    case 'legacy': return `${version} → v3 · 兼容模式`;
    case 'unsupported': return `${version} · 当前插件不支持`;
    case 'invalid': return '配置格式无效';
  }
}

function getSettingLabel(key: CatalogTabSettingKey): string {
  switch (key) {
    case 'autoOrganize': return '非项目标签自动移至末尾';
  }
}

function getSettingDescription(
  key: CatalogTabSettingKey,
  effective: ReturnType<typeof resolveEffectiveTabSettings>,
): string {
  switch (key) {
    case 'autoOrganize':
      return `${effective.values.autoOrganize ? '开启' : '关闭'} · ${effective.sources.autoOrganize}`;
  }
}

function getSettingTooltip(
  key: CatalogTabSettingKey,
  catalog: ActiveProjectCatalog | undefined,
  effective: ReturnType<typeof resolveEffectiveTabSettings>,
  contextKind: 'member' | 'external' | 'noWorkspace',
): string {
  const shared = catalog?.catalog.features.tabs;
  switch (key) {
    case 'autoOrganize':
      return `开启时会将工作区外文件、设置页、扩展说明等非项目标签稳定移到末尾；项目内标签保持用户顺序。\n当前生效：${effective.values.autoOrganize ? '开启' : '关闭'}（${effective.sources.autoOrganize}）\n集合默认：${shared?.autoOrganize === true ? '开启' : '关闭'}\n当前归属：${formatContextKind(contextKind)}`;
  }
}

function formatContextKind(kind: 'member' | 'external' | 'noWorkspace'): string {
  switch (kind) {
    case 'member': return '集合内项目，集合默认值可以生效';
    case 'external': return '集合外项目，集合默认值不生效';
    case 'noWorkspace': return '集合启动窗口，项目型配置不生效';
  }
}

function formatOutlineMode(mode: 'native' | 'enhanced' | 'both'): string {
  switch (mode) {
    case 'native': return '仅原生';
    case 'enhanced': return '仅增强';
    case 'both': return '同时使用';
  }
}

export function getCatalogViewDescription(catalog: ActiveProjectCatalog | undefined): string | undefined {
  if (catalog === undefined) {
    return undefined;
  }
  const fileName = path.posix.basename(catalog.uri.path);
  return catalog.catalog.name === undefined
    ? fileName
    : `${catalog.catalog.name} · ${fileName}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!]/gu, '\\$&');
}
