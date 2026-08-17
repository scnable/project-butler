import * as vscode from 'vscode';
import { ProjectCatalogServiceV2 } from '../projectCatalog/catalogServiceV2';
import { resolveEffectiveOutlineMode } from '../symbolOutline/outlineSettings';
import { resolveEffectiveTabSettings } from '../tabManagement/tabSettings';
import { detectVscodeCapabilities, VscodeCapabilities } from '../platform/vscodeCapabilities';
import { IconSemantic } from '../visual/iconSemantics';
import { createTreeIconPath } from '../visual/treeIconResources';

const COLLAPSE_STATE_KEY = 'projectManager.configurationView.groupExpansion';

type GroupId = 'collection' | 'project' | 'ai' | 'external' | 'outlineAppearance';

interface SummaryNode { readonly kind: 'summary' }
interface GroupNode { readonly kind: 'group'; readonly id: GroupId }
interface CollectionSettingNode { readonly kind: 'collectionSetting'; readonly key: 'autoOrganize' | 'outlineMode' }
interface PersonalSettingNode { readonly kind: 'personalSetting'; readonly key: PersonalSettingKey }

export type ConfigurationTreeNode = SummaryNode | GroupNode | CollectionSettingNode | PersonalSettingNode;

export type PersonalSettingKey = keyof typeof PERSONAL_SETTINGS;

export interface PersonalSettingApplyResult {
  readonly globalValue: string | boolean | number | undefined;
  readonly effectiveValue: string | boolean | number | undefined;
  readonly overridden: boolean;
}

interface Choice {
  readonly label: string;
  readonly value: string | boolean | number;
}

export interface ConfigurationInteraction {
  choose(definition: PersonalSettingDefinition, current: unknown): Promise<Choice | undefined>;
  confirmDisableAi(): Promise<boolean>;
  showWarning(message: string): Promise<void>;
  showInformation(message: string): Promise<void>;
}

export interface PersonalSettingDefinition {
  readonly label: string;
  readonly section: string;
  readonly key: string;
  readonly choices: readonly Choice[];
  readonly suffix?: string;
  readonly tooltip?: string;
}

const PERSONAL_SETTINGS = {
  tabDefault: setting('非项目标签自动移至末尾', 'projectManager.tabs', 'autoOrganize', booleanChoices(), undefined, '开启后，仅将工作区外文件、设置页、扩展说明等非项目标签稳定移到末尾；项目内标签保持用户顺序。'),
  openFilesView: setting('已打开文件视图', 'projectManager.tabs', 'openFilesView', [
    { label: '目录树', value: 'directoryTree' }, { label: 'VS Code 原生', value: 'native' },
  ], undefined, '目录树显示在资源管理器中，只读取已打开的普通文件；不会扫描项目。'),
  outlineModeDefault: setting('函数大纲模式默认值', 'projectManager.symbolOutline', 'mode', [
    { label: '仅原生', value: 'native' }, { label: '仅增强', value: 'enhanced' }, { label: '同时使用', value: 'both' },
  ]),
  openMode: setting('项目打开方式', 'projectManager.projectCatalog', 'openMode', [
    { label: '每次询问', value: 'prompt' }, { label: '新窗口', value: 'newWindow' }, { label: '当前窗口', value: 'currentWindow' },
  ]),
  confirmExclude: setting('屏蔽前确认', 'projectManager.exclusions', 'confirmBeforeApply', booleanChoices()),
  disableAiFeatures: setting('VS Code 内置 AI 功能', 'chat', 'disableAIFeatures', [
    { label: '开启', value: false },
    { label: '完全关闭', value: true },
  ], undefined, '直接修改用户级 chat.disableAIFeatures。完全关闭会隐藏并禁用 VS Code Chat、内联 AI 建议等内置功能，同时禁用 Copilot 扩展。拥有独立界面的第三方 Agent 扩展通常不会被直接禁用；依赖内置 Chat 的扩展能力将不可用。'),
  externalEnabled: setting('工作区外文件标识', 'projectManager.externalFiles', 'enabled', booleanChoices()),
  externalColor: setting('外部文件前景色', 'projectManager.externalFiles', 'showColor', booleanChoices()),
  externalBadge: setting('外部文件 ‼ 徽标', 'projectManager.externalFiles', 'showBadge', booleanChoices()),
  externalStatus: setting('外部文件状态栏提醒', 'projectManager.externalFiles', 'showStatusBar', booleanChoices()),
  outlineScope: setting('符号范围', 'projectManager.symbolOutline', 'scope', [
    { label: '仅函数', value: 'functions' }, { label: '函数与类型', value: 'functionsAndTypes' }, { label: '全部符号', value: 'all' },
  ]),
  outlineHierarchy: setting('层级方式', 'projectManager.symbolOutline', 'hierarchy', [
    { label: '树状', value: 'tree' }, { label: '平铺', value: 'flat' },
  ]),
  outlineSort: setting('排序方式', 'projectManager.symbolOutline', 'sort', [
    { label: '源码顺序', value: 'source' }, { label: '名称', value: 'name' }, { label: '类型与名称', value: 'typeName' },
  ]),
  outlineAppearance: setting('外观', 'projectManager.symbolOutline', 'appearance', [
    { label: '跟随 VS Code', value: 'vscode' }, { label: 'Source Insight 浅色', value: 'sourceInsightLight' }, { label: 'Source Insight 黑色', value: 'sourceInsightBlack' },
  ]),
  showLineMetrics: setting('显示行数', 'projectManager.symbolOutline', 'showLineMetrics', booleanChoices()),
  highlightLong: setting('突出长函数', 'projectManager.symbolOutline', 'highlightLongFunctions', booleanChoices()),
  highlightEdited: setting('标记已编辑符号', 'projectManager.symbolOutline', 'highlightEditedSymbols', booleanChoices()),
  outlineScale: setting('界面缩放', 'projectManager.symbolOutline', 'scale', [
    { label: '90%', value: 90 }, { label: '100%', value: 100 }, { label: '110%', value: 110 }, { label: '120%', value: 120 }, { label: '130%', value: 130 }, { label: '140%', value: 140 }, { label: '150%', value: 150 },
  ], '%'),
} as const satisfies Record<string, PersonalSettingDefinition>;

const GROUP_CHILDREN: Record<GroupId, readonly ConfigurationTreeNode[]> = {
  collection: [
    { kind: 'collectionSetting', key: 'autoOrganize' },
    { kind: 'collectionSetting', key: 'outlineMode' },
  ],
  project: [
    { kind: 'personalSetting', key: 'openFilesView' },
    { kind: 'personalSetting', key: 'openMode' },
    { kind: 'personalSetting', key: 'confirmExclude' },
  ],
  ai: [
    { kind: 'personalSetting', key: 'disableAiFeatures' },
  ],
  external: [
    { kind: 'personalSetting', key: 'externalEnabled' },
    { kind: 'personalSetting', key: 'externalColor' },
    { kind: 'personalSetting', key: 'externalBadge' },
    { kind: 'personalSetting', key: 'externalStatus' },
  ],
  outlineAppearance: [
    { kind: 'personalSetting', key: 'outlineAppearance' },
    { kind: 'personalSetting', key: 'showLineMetrics' },
    { kind: 'personalSetting', key: 'highlightLong' },
    { kind: 'personalSetting', key: 'highlightEdited' },
    { kind: 'personalSetting', key: 'outlineScale' },
  ],
};

export class ConfigurationTreeProvider implements vscode.TreeDataProvider<ConfigurationTreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ConfigurationTreeNode | undefined>();
  private readonly subscriptions: vscode.Disposable[];
  private expansion: Record<string, boolean>;
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(
    private readonly service: ProjectCatalogServiceV2,
    private readonly state: vscode.Memento,
    private readonly interaction: ConfigurationInteraction = vscodeConfigurationInteraction,
    private readonly capabilities: VscodeCapabilities = detectVscodeCapabilities(),
    private readonly extensionUri?: vscode.Uri,
  ) {
    this.expansion = state.get<Record<string, boolean>>(COLLAPSE_STATE_KEY, {});
    this.subscriptions = [
      service.onDidChange(() => this.changeEmitter.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('projectManager')
          || event.affectsConfiguration('chat.disableAIFeatures')) {
          this.changeEmitter.fire(undefined);
        }
      }),
    ];
  }

  public getChildren(node?: ConfigurationTreeNode): ConfigurationTreeNode[] {
    if (node?.kind === 'group') return [...GROUP_CHILDREN[node.id]];
    if (node !== undefined) return [];
    return [
      { kind: 'summary' },
      { kind: 'group', id: 'collection' },
      { kind: 'group', id: 'project' },
      { kind: 'group', id: 'ai' },
      { kind: 'group', id: 'external' },
      { kind: 'group', id: 'outlineAppearance' },
    ];
  }

  public getTreeItem(node: ConfigurationTreeNode): vscode.TreeItem {
    if (node.kind === 'summary') return this.createSummaryItem();
    if (node.kind === 'group') return this.createGroupItem(node.id);
    if (node.kind === 'collectionSetting') return this.createCollectionSettingItem(node.key);
    return this.createPersonalSettingItem(node.key);
  }

  public async setGroupExpanded(id: GroupId, expanded: boolean): Promise<void> {
    this.expansion = { ...this.expansion, [id]: expanded };
    await this.state.update(COLLAPSE_STATE_KEY, this.expansion);
  }

  public async configurePersonalSetting(key: PersonalSettingKey): Promise<void> {
    if (key === 'disableAiFeatures' && !this.capabilities.chatDisableAiFeatures.supported) {
      await this.interaction.showWarning(
        this.capabilities.chatDisableAiFeatures.reason
          ?? '当前 VS Code 不支持完全关闭内置 AI 功能。',
      );
      return;
    }
    const definition = PERSONAL_SETTINGS[key];
    const configuration = vscode.workspace.getConfiguration(definition.section);
    const inspected = configuration.inspect<unknown>(definition.key);
    const current = inspected?.globalValue ?? inspected?.defaultValue;
    const selected = await this.interaction.choose(definition, current);
    if (selected === undefined || selected.value === current) return;
    if (key === 'disableAiFeatures' && selected.value === true) {
      if (!(await this.interaction.confirmDisableAi())) return;
    }
    const result = await applyPersonalSettingValue(key, selected.value);
    if (key === 'disableAiFeatures') {
      if (result.overridden) {
        await this.interaction.showWarning(
          'VS Code 内置 AI 的用户设置已更新，但当前工作区存在更高优先级的覆盖值，因此本窗口的实际状态没有改变。',
        );
        return;
      }
    }
    await this.interaction.showInformation(`“${definition.label}”已保存并应用。`);
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changeEmitter.dispose();
  }

  private createSummaryItem(): vscode.TreeItem {
    const catalog = this.service.current;
    const context = this.service.projectContext;
    const label = catalog !== undefined && context.kind === 'member'
      ? `当前配置：${catalog.name}`
      : '当前配置：个人默认';
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = `修订 ${this.service.configurationRevision} · 已应用`;
    item.iconPath = this.iconPath('config', 'settings');
    item.tooltip = catalog === undefined
      ? '当前没有选择集合，项目功能使用个人默认值。'
      : context.kind === 'member'
        ? '当前工作区属于该集合，集合功能值正在生效。'
        : '当前工作区不属于活动集合，当前生效功能使用并编辑个人默认值。';
    return item;
  }

  private createGroupItem(id: GroupId): vscode.TreeItem {
    if (id === 'ai' && !this.capabilities.chatDisableAiFeatures.supported) {
      const item = new vscode.TreeItem('VS Code 内置 AI 功能', vscode.TreeItemCollapsibleState.Collapsed);
      item.description = '当前版本不支持 · 需要 1.104+';
      item.iconPath = new vscode.ThemeIcon('info');
      item.contextValue = 'projectManager.configurationGroup.ai';
      item.tooltip = this.capabilities.chatDisableAiFeatures.reason;
      return item;
    }
    const catalog = this.service.current;
    const data: Record<GroupId, { label: string; description: string; icon: string; semantic?: IconSemantic }> = {
      collection: {
        label: '当前生效功能',
        description: catalog !== undefined && this.service.projectContext.kind === 'member'
          ? `${catalog.name} · 集合内项目`
          : catalog === undefined
            ? '个人默认'
            : '个人默认 · 当前项目不在集合',
        icon: 'library',
        semantic: 'catalog',
      },
      project: { label: '项目与资源操作', description: '个人偏好', icon: 'project', semantic: 'resources' },
      ai: {
        label: 'VS Code 内置 AI 功能',
        description: vscode.workspace.getConfiguration('chat').get<boolean>('disableAIFeatures', false) ? '已完全关闭' : '已开启',
        icon: 'sparkle',
      },
      external: { label: '工作区外文件提醒', description: '个人偏好', icon: 'warning', semantic: 'external-file' },
      outlineAppearance: { label: '函数大纲显示', description: '个人偏好', icon: 'symbol-method', semantic: 'symbol.method' },
    };
    const definition = data[id];
    const expanded = this.expansion[id] ?? id === 'collection';
    const item = new vscode.TreeItem(definition.label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.description = definition.description;
    item.iconPath = definition.semantic === undefined
      ? new vscode.ThemeIcon(definition.icon)
      : this.iconPath(definition.semantic, definition.icon);
    item.contextValue = `projectManager.configurationGroup.${id}`;
    return item;
  }

  private createCollectionSettingItem(key: CollectionSettingNode['key']): vscode.TreeItem {
    const catalog = this.service.current;
    const memberCatalog = catalog !== undefined && this.service.projectContext.kind === 'member';
    if (key === 'autoOrganize') {
      const effective = resolveEffectiveTabSettings(this.service.currentProjectTabSettings);
      const item = new vscode.TreeItem('非项目标签自动移至末尾', vscode.TreeItemCollapsibleState.None);
      item.description = `${effective.values.autoOrganize ? '开启' : '关闭'} · ${effective.sources.autoOrganize}`;
      item.iconPath = new vscode.ThemeIcon(effective.values.autoOrganize ? 'pass-filled' : 'circle-slash');
      item.command = { command: 'projectManager.configureCatalogTabSetting', title: '配置非项目标签自动移至末尾', arguments: ['autoOrganize'] };
      item.tooltip = memberCatalog
        ? `当前项目属于“${catalog.name}”。可设置集合覆盖值，或选择“跟随个人默认”。`
        : '当前项目不属于活动集合，点击后修改个人默认值。';
      return item;
    }
    const effective = resolveEffectiveOutlineMode(this.service.currentProjectSymbolOutlineSettings);
    const item = new vscode.TreeItem('函数大纲模式', vscode.TreeItemCollapsibleState.None);
    item.description = `${formatMode(effective.mode)} · ${effective.source}`;
    item.iconPath = new vscode.ThemeIcon('list-tree');
    item.command = { command: 'projectManager.configureCatalogOutlineMode', title: '配置函数大纲模式' };
    item.tooltip = memberCatalog
      ? `当前项目属于“${catalog.name}”。可设置集合覆盖值，或选择“跟随个人默认”。`
      : '当前项目不属于活动集合，点击后修改个人默认值。';
    return item;
  }

  private createPersonalSettingItem(key: PersonalSettingKey): vscode.TreeItem {
    if (key === 'disableAiFeatures' && !this.capabilities.chatDisableAiFeatures.supported) {
      const item = new vscode.TreeItem('VS Code 内置 AI 功能', vscode.TreeItemCollapsibleState.None);
      item.description = '不可用 · 需要 VS Code 1.104+';
      item.iconPath = new vscode.ThemeIcon('info');
      item.tooltip = this.capabilities.chatDisableAiFeatures.reason;
      item.contextValue = 'projectManager.unsupportedSetting';
      return item;
    }
    const definition = PERSONAL_SETTINGS[key];
    const inspected = vscode.workspace.getConfiguration(definition.section).inspect<unknown>(definition.key);
    const value = inspected?.globalValue ?? inspected?.defaultValue;
    const effective = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? value;
    const selected = definition.choices.find((choice) => choice.value === value);
    const item = new vscode.TreeItem(definition.label, vscode.TreeItemCollapsibleState.None);
    item.description = `${selected?.label ?? String(value ?? '使用插件默认值')}${effective !== value ? ' · 当前工作区覆盖' : ''}`;
    item.iconPath = key === 'disableAiFeatures'
      ? new vscode.ThemeIcon(value === true ? 'circle-slash' : 'sparkle')
      : typeof value === 'boolean'
      ? new vscode.ThemeIcon(value ? 'pass-filled' : 'circle-slash')
      : new vscode.ThemeIcon('settings-gear');
    item.command = { command: 'projectManager.configurePersonalSetting', title: `配置${definition.label}`, arguments: [key] };
    item.tooltip = definition.tooltip
      ?? `保存到个人设置，选择后立即生效。${definition.suffix === undefined ? '' : `显示单位：${definition.suffix}`}`;
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

const vscodeConfigurationInteraction: ConfigurationInteraction = {
  async choose(definition, current) {
    return vscode.window.showQuickPick(definition.choices.map((choice) => ({
      ...choice,
      description: choice.value === current ? '当前值' : '',
    })), { title: `个人偏好：${definition.label}` });
  },
  async confirmDisableAi() {
    const confirmed = await vscode.window.showWarningMessage(
      '确认完全关闭 VS Code 内置 AI 功能吗？',
      {
        modal: true,
        detail: '这不仅会隐藏 Chat，还会禁用内联 AI 建议等内置功能，并禁用 Copilot 扩展。拥有独立界面的第三方 Agent 扩展通常不被直接禁用，但依赖内置 Chat 的功能将不可用。可以稍后从同一位置重新开启。',
      },
      '完全关闭',
    );
    return confirmed === '完全关闭';
  },
  async showWarning(message) {
    await vscode.window.showWarningMessage(message);
  },
  async showInformation(message) {
    await vscode.window.showInformationMessage(message);
  },
};

export async function applyPersonalSettingValue(
  key: PersonalSettingKey,
  value: string | boolean | number,
  capabilities: VscodeCapabilities = detectVscodeCapabilities(),
): Promise<PersonalSettingApplyResult> {
  if (key === 'disableAiFeatures' && !capabilities.chatDisableAiFeatures.supported) {
    throw new Error(capabilities.chatDisableAiFeatures.reason
      ?? '当前 VS Code 不支持 chat.disableAIFeatures。');
  }
  const definition = PERSONAL_SETTINGS[key];
  if (!definition.choices.some((choice) => choice.value === value)) {
    throw new Error(`配置“${definition.label}”不支持值：${String(value)}`);
  }
  const configuration = vscode.workspace.getConfiguration(definition.section);
  await configuration.update(definition.key, value, vscode.ConfigurationTarget.Global);
  const inspected = configuration.inspect<string | boolean | number>(definition.key);
  const globalValue = inspected?.globalValue ?? inspected?.defaultValue;
  const effectiveValue = configuration.get<string | boolean | number>(definition.key);
  return {
    globalValue,
    effectiveValue,
    overridden: effectiveValue !== value,
  };
}

function setting(
  label: string,
  section: string,
  key: string,
  choices: readonly Choice[],
  suffix?: string,
  tooltip?: string,
): PersonalSettingDefinition {
  return {
    label,
    section,
    key,
    choices,
    ...(suffix === undefined ? {} : { suffix }),
    ...(tooltip === undefined ? {} : { tooltip }),
  };
}

function booleanChoices(): readonly Choice[] {
  return [{ label: '开启', value: true }, { label: '关闭', value: false }];
}

function formatMode(mode: 'native' | 'enhanced' | 'both'): string {
  return mode === 'native' ? '仅原生' : mode === 'enhanced' ? '仅增强' : '同时使用';
}
