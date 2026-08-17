import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  applyPersonalSettingValue,
  type ConfigurationInteraction,
  ConfigurationTreeProvider,
  type ConfigurationTreeNode,
} from '../configuration/configurationTreeProvider';
import { createStoredCatalog } from '../projectCatalog/catalogStore';
import { resolveVscodeCapabilities } from '../platform/vscodeCapabilitiesModel';
import {
  createCatalogForWorkspace,
  getApi,
  projectUri,
  resetCatalogs,
  seedCatalogs,
  setGlobalSetting,
} from './helpers';

suite('配置侧栏、优先级与实时生效', () => {
  suiteTeardown(async () => {
    const api = await getApi();
    await resetCatalogs(api);
    await restorePersonalDefaults();
  });

  test('INT-017 未选择集合时显示个人默认摘要', async () => {
    const api = await getApi();
    await resetCatalogs(api);
    const roots = api.catalogs.configurationProvider.getChildren();
    const summary = api.catalogs.configurationProvider.getTreeItem(roots[0] as ConfigurationTreeNode);
    assert.equal(summary.label, '当前配置：个人默认');
    assert.equal(roots.some((node) => node.kind === 'group' && node.id === 'collection'), true);
  });

  test('INT-018 集合内项目显示集合名称和已应用上下文', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('成员集合');
    await seedCatalogs(api, [catalog], catalog.id);
    const summary = api.catalogs.configurationProvider.getTreeItem(api.catalogs.configurationProvider.getChildren()[0] as ConfigurationTreeNode);
    assert.equal(summary.label, '当前配置：成员集合');
    assert.match(String(summary.tooltip), /属于该集合/);
  });

  test('INT-019 集合外项目明确显示个人默认正在生效', async () => {
    const api = await getApi();
    const catalog = createStoredCatalog('集合外上下文', [{
      alias: '工作区二',
      uri: projectUri(api, 'test-fixtures/workspace-two').toString(),
      type: 'folder',
    }]);
    await seedCatalogs(api, [catalog], catalog.id);
    const summary = api.catalogs.configurationProvider.getTreeItem(api.catalogs.configurationProvider.getChildren()[0] as ConfigurationTreeNode);
    assert.equal(summary.label, '当前配置：个人默认');
    assert.match(String(summary.tooltip), /不属于活动集合.*个人默认值/);
  });

  test('INT-020 配置分组顺序和名称完整', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('配置顺序');
    await seedCatalogs(api, [catalog], catalog.id);
    const groups = api.catalogs.configurationProvider.getChildren().filter((node) => node.kind === 'group');
    const labels = groups.map((node) => String(api.catalogs.configurationProvider.getTreeItem(node).label));
    assert.deepEqual(labels, [
      '当前生效功能',
      '项目与资源操作',
      'VS Code 内置 AI 功能',
      '工作区外文件提醒',
      '函数大纲显示',
    ]);
  });

  test('INT-021 配置分组折叠状态可持久化并重建读取', async () => {
    const api = await getApi();
    await api.catalogs.configurationProvider.setGroupExpanded('external', true);
    const replacement = new ConfigurationTreeProvider(api.catalogs.service, api.context.globalState);
    try {
      const node = replacement.getChildren().find((candidate) => candidate.kind === 'group' && candidate.id === 'external');
      assert.ok(node);
      assert.equal(replacement.getTreeItem(node).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    } finally {
      replacement.dispose();
    }
  });

  test('INT-022 集合级非项目标签自动移至末尾开关写入内部集合', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('标签配置', { autoOrganize: false });
    await seedCatalogs(api, [catalog], catalog.id);
    await api.catalogs.service.updateCurrentTabAutoOrganize(true);
    assert.equal(api.catalogs.service.current?.features.tabs.autoOrganize, true);
    assert.equal(api.catalogs.service.currentProjectTabSettings?.autoOrganize, true);
  });

  test('INT-023 集合级函数大纲模式立即写入', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('大纲配置', { outlineMode: 'both' });
    await seedCatalogs(api, [catalog], catalog.id);
    assert.equal(await api.catalogs.service.updateCurrentOutlineMode('enhanced', false), true);
    assert.equal(api.catalogs.service.current?.features.symbolOutline.mode, 'enhanced');
  });

  test('INT-187 新集合未声明覆盖值时跟随个人默认', async () => {
    const api = await getApi();
    const catalog = createStoredCatalog('跟随个人默认', [{
      alias: '工作区一',
      uri: projectUri(api, 'test-fixtures/workspace-one').toString(),
      type: 'folder',
    }]);
    await seedCatalogs(api, [catalog], catalog.id);
    assert.equal(api.catalogs.service.projectContext.kind, 'member');
    assert.equal(api.catalogs.service.currentProjectTabSettings, undefined);
    assert.equal(api.catalogs.service.currentProjectSymbolOutlineSettings, undefined);

    const group = api.catalogs.configurationProvider.getChildren()
      .find((node) => node.kind === 'group' && node.id === 'collection');
    assert.ok(group);
    const descriptions = api.catalogs.configurationProvider.getChildren(group)
      .map((node) => String(api.catalogs.configurationProvider.getTreeItem(node).description));
    assert.equal(descriptions.some((description) => description.includes('项目集合')), false);
  });

  test('INT-024 个人非项目标签自动移至末尾默认值写入用户作用域', async () => {
    const result = await applyPersonalSettingValue('tabDefault', true);
    assert.equal(result.globalValue, true);
    assert.equal(vscode.workspace.getConfiguration('projectManager.tabs').inspect<boolean>('autoOrganize')?.globalValue, true);
    await applyPersonalSettingValue('tabDefault', false);
  });

  test('INT-025 个人函数大纲模式默认值写入用户作用域', async () => {
    const result = await applyPersonalSettingValue('outlineModeDefault', 'enhanced');
    assert.equal(result.globalValue, 'enhanced');
    await applyPersonalSettingValue('outlineModeDefault', 'both');
  });

  test('INT-026 项目打开方式三个枚举值均可即时保存', async () => {
    for (const value of ['prompt', 'newWindow', 'currentWindow'] as const) {
      const result = await applyPersonalSettingValue('openMode', value);
      assert.equal(result.globalValue, value);
    }
    await applyPersonalSettingValue('openMode', 'prompt');
  });

  test('INT-027 屏蔽前确认开关可即时保存', async () => {
    assert.equal((await applyPersonalSettingValue('confirmExclude', false)).globalValue, false);
    assert.equal((await applyPersonalSettingValue('confirmExclude', true)).globalValue, true);
  });

  test('INT-028 完全关闭内置 AI 前确认并写入用户级 true', async () => {
    const api = await getApi();
    await applyPersonalSettingValue('disableAiFeatures', false);
    const provider = new ConfigurationTreeProvider(api.catalogs.service, api.context.globalState, interaction(true, true));
    await provider.configurePersonalSetting('disableAiFeatures');
    provider.dispose();
    assert.equal(vscode.workspace.getConfiguration('chat').inspect<boolean>('disableAIFeatures')?.globalValue, true);
  });

  test('INT-029 取消关闭内置 AI 不修改配置', async () => {
    const api = await getApi();
    await applyPersonalSettingValue('disableAiFeatures', false);
    const provider = new ConfigurationTreeProvider(api.catalogs.service, api.context.globalState, interaction(true, false));
    await provider.configurePersonalSetting('disableAiFeatures');
    provider.dispose();
    assert.equal(vscode.workspace.getConfiguration('chat').inspect<boolean>('disableAIFeatures')?.globalValue, false);
  });

  test('INT-030 从侧栏重新开启内置 AI', async () => {
    const api = await getApi();
    await applyPersonalSettingValue('disableAiFeatures', true);
    const provider = new ConfigurationTreeProvider(api.catalogs.service, api.context.globalState, interaction(false, true));
    await provider.configurePersonalSetting('disableAiFeatures');
    provider.dispose();
    assert.equal(vscode.workspace.getConfiguration('chat').inspect<boolean>('disableAIFeatures')?.globalValue, false);
  });

  test('INT-031 外部修改 AI 设置后配置树触发刷新', async () => {
    const api = await getApi();
    const changed = new Promise<void>((resolve) => {
      const disposable = api.catalogs.configurationProvider.onDidChangeTreeData(() => {
        disposable.dispose();
        resolve();
      });
    });
    await setGlobalSetting('chat', 'disableAIFeatures', true);
    await changed;
    const group = api.catalogs.configurationProvider.getChildren().find((node) => node.kind === 'group' && node.id === 'ai');
    assert.ok(group);
    assert.equal(api.catalogs.configurationProvider.getTreeItem(group).description, '已开启');
    await setGlobalSetting('chat', 'disableAIFeatures', false);
  });

  test('INT-032 AI 工作区覆盖在配置条目中可见', async () => {
    const api = await getApi();
    await applyPersonalSettingValue('disableAiFeatures', true);
    const group = api.catalogs.configurationProvider.getChildren().find((node) => node.kind === 'group' && node.id === 'ai');
    assert.ok(group);
    const item = api.catalogs.configurationProvider.getTreeItem(api.catalogs.configurationProvider.getChildren(group)[0] as ConfigurationTreeNode);
    assert.match(String(item.description), /当前工作区覆盖/);
    await applyPersonalSettingValue('disableAiFeatures', false);
  });

  for (const entry of [
    ['INT-033', 'externalEnabled', false, 'projectManager.externalFiles', 'enabled'],
    ['INT-034', 'externalColor', false, 'projectManager.externalFiles', 'showColor'],
    ['INT-035', 'externalBadge', false, 'projectManager.externalFiles', 'showBadge'],
    ['INT-036', 'externalStatus', false, 'projectManager.externalFiles', 'showStatusBar'],
    ['INT-037', 'outlineScope', 'all', 'projectManager.symbolOutline', 'scope'],
    ['INT-038', 'outlineHierarchy', 'flat', 'projectManager.symbolOutline', 'hierarchy'],
    ['INT-039', 'outlineSort', 'name', 'projectManager.symbolOutline', 'sort'],
    ['INT-040', 'outlineAppearance', 'sourceInsightBlack', 'projectManager.symbolOutline', 'appearance'],
    ['INT-042', 'showLineMetrics', false, 'projectManager.symbolOutline', 'showLineMetrics'],
    ['INT-043', 'highlightLong', false, 'projectManager.symbolOutline', 'highlightLongFunctions'],
    ['INT-044', 'highlightEdited', false, 'projectManager.symbolOutline', 'highlightEditedSymbols'],
    ['INT-045', 'outlineScale', 120, 'projectManager.symbolOutline', 'scale'],
  ] as const) {
    test(`${entry[0]} ${entry[1]} 个人设置即时写入`, async () => {
      const [, key, value, section, settingKey] = entry;
      const result = await applyPersonalSettingValue(key, value);
      assert.equal(result.globalValue, value);
      assert.equal(vscode.workspace.getConfiguration(section).inspect(settingKey)?.globalValue, value);
    });
  }

  test('INT-041 已移除的签名显示选项不再注册', async () => {
    const inspected = vscode.workspace.getConfiguration('projectManager.symbolOutline').inspect('showSignature');
    assert.equal(inspected?.defaultValue, undefined);
    const api = await getApi();
    const group = api.catalogs.configurationProvider.getChildren()
      .find((node) => node.kind === 'group' && node.id === 'outlineAppearance');
    assert.ok(group);
    assert.equal(
      api.catalogs.configurationProvider.getChildren(group)
        .some((node) => node.kind === 'personalSetting' && String(node.key) === 'showSignature'),
      false,
    );
  });

  test('INT-046 projectManager 配置外部变化触发配置树刷新', async () => {
    const api = await getApi();
    const changed = new Promise<void>((resolve) => {
      const disposable = api.catalogs.configurationProvider.onDidChangeTreeData(() => {
        disposable.dispose();
        resolve();
      });
    });
    await setGlobalSetting('projectManager.externalFiles', 'showBadge', true);
    await changed;
  });

  test('INT-047 VS Code 配置检查结果体现工作区高于用户级', async () => {
    await setGlobalSetting('chat', 'disableAIFeatures', true);
    const inspected = vscode.workspace.getConfiguration('chat').inspect<boolean>('disableAIFeatures');
    assert.equal(inspected?.globalValue, true);
    assert.equal(inspected?.workspaceValue, false);
    assert.equal(vscode.workspace.getConfiguration('chat').get<boolean>('disableAIFeatures'), false);
    await setGlobalSetting('chat', 'disableAIFeatures', false);
  });

  test('INT-048 无效配置值被拒绝并保留上一有效值', async () => {
    await applyPersonalSettingValue('outlineScale', 100);
    await assert.rejects(() => applyPersonalSettingValue('outlineScale', 999), /不支持值/);
    assert.equal(vscode.workspace.getConfiguration('projectManager.symbolOutline').inspect<number>('scale')?.globalValue, 100);
  });

  test('INT-049 取消配置选择器不会改变值', async () => {
    const api = await getApi();
    await applyPersonalSettingValue('externalBadge', true);
    const provider = new ConfigurationTreeProvider(api.catalogs.service, api.context.globalState, interaction(undefined, true));
    await provider.configurePersonalSetting('externalBadge');
    provider.dispose();
    assert.equal(vscode.workspace.getConfiguration('projectManager.externalFiles').inspect<boolean>('showBadge')?.globalValue, true);
  });

  test('INT-050 配置值在 Provider 重建后保持', async () => {
    const api = await getApi();
    await applyPersonalSettingValue('outlineAppearance', 'sourceInsightLight');
    const replacement = new ConfigurationTreeProvider(api.catalogs.service, api.context.globalState);
    try {
      const group = replacement.getChildren().find((node) => node.kind === 'group' && node.id === 'outlineAppearance');
      assert.ok(group);
      const appearanceNode = replacement.getChildren(group).find((node) => node.kind === 'personalSetting' && node.key === 'outlineAppearance');
      assert.ok(appearanceNode);
      assert.match(String(replacement.getTreeItem(appearanceNode).description), /Source Insight 浅色/);
    } finally {
      replacement.dispose();
    }
  });

  test('INT-174 函数大纲高频浏览项不在配置栏重复出现', async () => {
    const api = await getApi();
    const group = api.catalogs.configurationProvider.getChildren()
      .find((node) => node.kind === 'group' && node.id === 'outlineAppearance');
    assert.ok(group);
    const keys = api.catalogs.configurationProvider.getChildren(group)
      .filter((node) => node.kind === 'personalSetting')
      .map((node) => node.key);
    assert.deepEqual(keys, [
      'outlineAppearance',
      'showLineMetrics',
      'highlightLong',
      'highlightEdited',
      'outlineScale',
    ]);
  });

  test('INT-176 旧版 VS Code 的内置 AI 设置显示为不可用且不进入选择流程', async () => {
    const api = await getApi();
    const capabilities = resolveVscodeCapabilities('1.88.0', { chatDisableAiFeatures: false });
    let chooseCount = 0;
    let warning = '';
    const provider = new ConfigurationTreeProvider(
      api.catalogs.service,
      api.context.globalState,
      {
        async choose() {
          chooseCount += 1;
          return { label: '完全关闭', value: true };
        },
        async confirmDisableAi() { return true; },
        async showWarning(message) { warning = message; },
        async showInformation() {},
      },
      capabilities,
    );
    try {
      const group = provider.getChildren().find((node) => node.kind === 'group' && node.id === 'ai');
      assert.ok(group);
      assert.match(String(provider.getTreeItem(group).description), /1\.104/);
      const settingNode = provider.getChildren(group)[0] as ConfigurationTreeNode;
      const settingItem = provider.getTreeItem(settingNode);
      assert.equal(settingItem.command, undefined);
      assert.match(String(settingItem.description), /不可用/);
      await provider.configurePersonalSetting('disableAiFeatures');
      assert.equal(chooseCount, 0);
      assert.match(warning, /1\.104/);
    } finally {
      provider.dispose();
    }
  });

  test('INT-177 能力缺失时底层 AI 配置写入同样被拒绝', async () => {
    const capabilities = resolveVscodeCapabilities('1.133.0', { chatDisableAiFeatures: false });

    await assert.rejects(
      () => applyPersonalSettingValue('disableAiFeatures', true, capabilities),
      /未注册 chat\.disableAIFeatures/,
    );
  });
});

function interaction(value: string | boolean | number | undefined, confirmation: boolean): ConfigurationInteraction {
  return {
    async choose(definition) {
      return definition.choices.find((choice) => choice.value === value);
    },
    async confirmDisableAi() {
      return confirmation;
    },
    async showWarning() {},
    async showInformation() {},
  };
}

async function restorePersonalDefaults(): Promise<void> {
  await applyPersonalSettingValue('tabDefault', false);
  await applyPersonalSettingValue('outlineModeDefault', 'both');
  await applyPersonalSettingValue('openMode', 'prompt');
  await applyPersonalSettingValue('confirmExclude', true);
  await applyPersonalSettingValue('disableAiFeatures', false);
  await applyPersonalSettingValue('externalEnabled', true);
  await applyPersonalSettingValue('externalColor', true);
  await applyPersonalSettingValue('externalBadge', true);
  await applyPersonalSettingValue('externalStatus', true);
  await applyPersonalSettingValue('outlineScope', 'functionsAndTypes');
  await applyPersonalSettingValue('outlineHierarchy', 'tree');
  await applyPersonalSettingValue('outlineSort', 'source');
  await applyPersonalSettingValue('outlineAppearance', 'vscode');
  await applyPersonalSettingValue('showLineMetrics', true);
  await applyPersonalSettingValue('highlightLong', true);
  await applyPersonalSettingValue('highlightEdited', true);
  await applyPersonalSettingValue('outlineScale', 100);
}
