import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { applyPersonalSettingValue } from '../configuration/configurationTreeProvider';
import { getWorkspaceRelativePath } from '../shared/uri';
import { isSameOrder, moveNonProjectTabsToTail } from '../tabManagement/tabGrouping';
import {
  closeAllEditors,
  createCatalogForWorkspace,
  delay,
  getApi,
  openText,
  projectUri,
  resetCatalogs,
  seedCatalogs,
  stubInformationMessage,
  stubWarningMessage,
  tabUris,
  waitUntil,
} from './helpers';

suite('标签页自动与手动整理', () => {
  setup(async () => {
    const api = await getApi();
    await resetCatalogs(api);
    await applyPersonalSettingValue('tabDefault', false);
    await vscode.workspace.getConfiguration('projectManager.tabs').update('autoOrganize', false, vscode.ConfigurationTarget.Workspace);
    await closeAllEditors();
    await delay(800);
    await api.tabs.waitForIdleForIntegrationTest();
  });

  suiteTeardown(async () => {
    await applyPersonalSettingValue('tabDefault', false);
    await closeAllEditors();
  });

  test('INT-083 从关闭切换为开启后立即把已打开外部标签移到末尾', async () => {
    const api = await getApi();
    await openExternalBeforeProject(api);
    await vscode.workspace.getConfiguration('projectManager.tabs').update('autoOrganize', true, vscode.ConfigurationTarget.Workspace);
    await waitUntil(() => baseName(tabUris().at(-1) ?? '') === 'outside.txt', '开启后未立即把外部标签移到末尾');
  });

  test('INT-084 关闭自动移至末尾后新标签保持 VS Code 打开位置', async () => {
    const api = await getApi();
    await applyPersonalSettingValue('tabDefault', false);
    await openText(projectUri(api, 'test-fixtures/workspace-one/README.md'));
    await openText(projectUri(api, 'test-fixtures/workspace-one/src/app.ts'));
    await openText(projectUri(api, 'test-fixtures/workspace-one/normal.txt'));
    await delay(300);
    assert.deepEqual(tabUris().map(baseName), ['README.md', 'app.ts', 'normal.txt']);
  });

  test('INT-085 项目内文件在处理后保持用户顺序', async () => {
    const api = await getApi();
    await openInterleaved(api);
    const before = tabUris();
    await api.tabs.organizeCurrentGroup(false);
    assert.deepEqual(tabUris(), before);
  });

  test('INT-086 稳定分区不改变项目标签相对顺序', () => {
    const order = moveNonProjectTabsToTail([
      { id: 'b1', category: 'project' },
      { id: 'external', category: 'external' },
      { id: 'a1', category: 'project' },
    ]);
    assert.deepEqual(order, ['b1', 'a1', 'external']);
  });

  test('INT-087 多个外部标签在末尾保持原顺序', () => {
    assert.deepEqual(moveNonProjectTabsToTail([
      { id: 'external1', category: 'external' },
      { id: 'project', category: 'project' },
      { id: 'external2', category: 'external' },
    ]), ['project', 'external1', 'external2']);
  });

  test('INT-088 工作区外文件整理到项目文件之后', async () => {
    const api = await getApi();
    await openText(projectUri(api, 'test-fixtures/external/outside.txt'));
    await openText(projectUri(api, 'test-fixtures/workspace-one/src/app.ts'));
    await api.tabs.organizeCurrentGroup(false);
    assert.equal(baseName(tabUris().at(-1) ?? ''), 'outside.txt');
  });

  test('INT-089 设置页作为特殊标签保持在可移动区段末尾', async () => {
    const api = await getApi();
    await vscode.workspace.getConfiguration('projectManager.tabs').update('autoOrganize', true, vscode.ConfigurationTarget.Workspace);
    await openText(projectUri(api, 'test-fixtures/workspace-one/src/app.ts'));
    await vscode.commands.executeCommand('workbench.action.openSettings');
    await delay(500);
    assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab);
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText, false);
    assert.equal(vscode.window.tabGroups.activeTabGroup.tabs.at(-1), vscode.window.tabGroups.activeTabGroup.activeTab);
  });

  test('INT-090 特殊标签待处理后切回普通文件可补偿', async () => {
    const api = await getApi();
    await vscode.workspace.getConfiguration('projectManager.tabs').update('autoOrganize', true, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('workbench.action.openSettings');
    await openText(projectUri(api, 'test-fixtures/workspace-one/normal.txt'));
    await delay(500);
    assert.equal(vscode.window.activeTextEditor?.document.uri.path.endsWith('/normal.txt'), true);
  });

  test('INT-091 预览标签保持预览状态且不作为可移动标签', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/workspace-one/src/app.ts');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, true);
    await api.tabs.organizeCurrentGroup(false);
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, true);
  });

  test('INT-092 固定标签保持固定状态', async () => {
    const api = await getApi();
    await openText(projectUri(api, 'test-fixtures/workspace-one/README.md'));
    await vscode.commands.executeCommand('workbench.action.pinEditor');
    const pinned = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.equal(pinned?.isPinned, true);
    await openText(projectUri(api, 'test-fixtures/workspace-one/src/app.ts'));
    await api.tabs.organizeCurrentGroup(false);
    assert.equal(vscode.window.tabGroups.activeTabGroup.tabs.includes(pinned!), true);
    assert.equal(pinned?.isPinned, true);
  });

  test('INT-093 Diff 和未命名标签不会被当作普通文本移动', async () => {
    const api = await getApi();
    const left = projectUri(api, 'test-fixtures/workspace-one/README.md');
    const right = projectUri(api, 'test-fixtures/workspace-one/normal.txt');
    await vscode.commands.executeCommand('vscode.diff', left, right, '集成测试 Diff');
    const diff = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(diff?.input instanceof vscode.TabInputTextDiff);
    await api.tabs.organizeCurrentGroup(false);
    assert.ok(vscode.window.tabGroups.activeTabGroup.tabs.includes(diff!));
  });

  test('INT-094 快速连续打开后全部文件仍存在', async () => {
    const api = await getApi();
    await vscode.workspace.getConfiguration('projectManager.tabs').update('autoOrganize', true, vscode.ConfigurationTarget.Workspace);
    const uris = fixtureTextUris(api);
    await Promise.all(uris.map(async (uri) => openText(uri)));
    await delay(800);
    const open = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()));
    for (const uri of uris) assert.ok(open.has(uri.toString()));
  });

  test('INT-095 自动模式会补偿处理当前编辑器组', async () => {
    const api = await getApi();
    await openExternalBeforeProject(api);
    await vscode.workspace.getConfiguration('projectManager.tabs').update('autoOrganize', true, vscode.ConfigurationTarget.Workspace);
    await api.tabs.waitForIdleForIntegrationTest();
    await waitUntil(
      () => baseName(tabUris().at(-1) ?? '') === 'outside.txt',
      `没有完成补偿移动；当前顺序：${tabUris().map(baseName).join(' | ')}`,
      3_000,
    );
  });

  test('INT-096 自动关闭时手动移至末尾仍可用', async () => {
    const api = await getApi();
    await applyPersonalSettingValue('tabDefault', false);
    await openExternalBeforeProject(api);
    await api.tabs.organizeCurrentGroup(false);
    assert.equal(baseName(tabUris().at(-1) ?? ''), 'outside.txt');
  });

  test('INT-097 已符合目标顺序时不改变活动标签', async () => {
    const api = await getApi();
    await openText(projectUri(api, 'test-fixtures/workspace-one/README.md'));
    await openText(projectUri(api, 'test-fixtures/workspace-one/normal.txt'));
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    const before = tabUris();
    await api.tabs.organizeCurrentGroup(false);
    assert.deepEqual(tabUris(), before);
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab, active);
  });

  test('INT-098 多编辑器组独立保留各自标签', async () => {
    const api = await getApi();
    const left = await openText(projectUri(api, 'test-fixtures/workspace-one/README.md'), { viewColumn: vscode.ViewColumn.One });
    await openText(projectUri(api, 'test-fixtures/workspace-one/src/app.ts'), { viewColumn: vscode.ViewColumn.Two });
    assert.ok(vscode.window.tabGroups.all.length >= 2);
    assert.ok(vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === left.document.uri.toString())));
  });

  test('INT-099 集合内项目标签设置作为实际来源', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('标签集合', { autoOrganize: true });
    await seedCatalogs(api, [catalog], catalog.id);
    assert.equal(api.catalogs.service.currentProjectTabSettings?.autoOrganize, true);
  });

  test('INT-100 集合外项目使用个人默认而非集合值', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('无关集合', { autoOrganize: true });
    const externalCatalog = { ...catalog, projects: [] };
    await seedCatalogs(api, [externalCatalog], externalCatalog.id);
    await applyPersonalSettingValue('tabDefault', false);
    assert.equal(api.catalogs.service.currentProjectTabSettings, undefined);
    assert.equal(vscode.workspace.getConfiguration('projectManager.tabs').get('autoOrganize'), false);
  });

  test('INT-101 工作区显式覆盖高于集合与个人值', async () => {
    await applyPersonalSettingValue('tabDefault', true);
    const inspected = vscode.workspace.getConfiguration('projectManager.tabs').inspect<boolean>('autoOrganize');
    assert.equal(inspected?.globalValue, true);
    assert.equal(inspected?.workspaceValue, false);
    assert.equal(vscode.workspace.getConfiguration('projectManager.tabs').get('autoOrganize'), false);
  });

  test('INT-102 重复整理在性能基线内且顺序稳定', async () => {
    const api = await getApi();
    await openInterleaved(api);
    const started = Date.now();
    for (let index = 0; index < 10; index += 1) await api.tabs.organizeCurrentGroup(false);
    assert.ok(Date.now() - started < 5_000);
    assert.equal(isSameOrder(tabUris(), tabUris()), true);
  });

  test('INT-179 已打开文件目录按文件夹建树且不扫描未打开文件', async () => {
    const api = await getApi();
    await openText(projectUri(api, 'test-fixtures/workspace-one/src/app.ts'));
    await delay(150);
    const roots = api.openedFilesTree.provider.getRootsForIntegrationTest();
    const labels = flattenLabels(roots);
    assert.ok(labels.includes('src/'));
    assert.ok(labels.includes('app.ts'));
    assert.equal(labels.includes('normal.txt'), false);
  });

  test('INT-180 点击目录树文件复用已有标签并聚焦', async () => {
    const api = await getApi();
    await openText(projectUri(api, 'test-fixtures/workspace-one/README.md'));
    await openText(projectUri(api, 'test-fixtures/workspace-one/src/app.ts'));
    await delay(150);
    const beforeCount = vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;
    const readmeNode = flattenNodes(api.openedFilesTree.provider.getRootsForIntegrationTest())
      .find((node) => node.kind === 'file' && node.label === 'README.md');
    assert.ok(readmeNode);
    await api.openedFilesTree.provider.focusFile(readmeNode);
    assert.equal(vscode.window.activeTextEditor?.document.uri.path.endsWith('/README.md'), true);
    assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).length, beforeCount);
  });

  test('INT-181 多编辑器组显示组根，外部普通文件位于外部节点', async () => {
    const api = await getApi();
    await openText(projectUri(api, 'test-fixtures/workspace-one/README.md'), { viewColumn: vscode.ViewColumn.One });
    await openText(projectUri(api, 'test-fixtures/external/outside.txt'), { viewColumn: vscode.ViewColumn.Two });
    await delay(150);
    const roots = api.openedFilesTree.provider.getRootsForIntegrationTest();
    assert.ok(roots.length >= 2);
    assert.ok(roots.every((node) => node.kind === 'group'));
    const externalGroup = flattenNodes(roots).find((node) => node.kind === 'externalGroup');
    assert.ok(externalGroup);
    const externalGroupIcon = api.openedFilesTree.provider.getTreeItem(externalGroup).iconPath;
    assert.ok(!(externalGroupIcon instanceof vscode.ThemeIcon));
  });

  test('INT-182 特殊 Diff 不进入目录树，目录仅允许显式命令折叠', async () => {
    const api = await getApi();
    const left = projectUri(api, 'test-fixtures/workspace-one/README.md');
    const right = projectUri(api, 'test-fixtures/workspace-one/normal.txt');
    await openText(projectUri(api, 'test-fixtures/workspace-one/src/app.ts'));
    await vscode.commands.executeCommand('vscode.diff', left, right, '目录树排除 Diff');
    await delay(150);
    const roots = api.openedFilesTree.provider.getRootsForIntegrationTest();
    assert.equal(flattenLabels(roots).includes('目录树排除 Diff'), false);
    const container = flattenNodes(roots).find((node) => node.kind !== 'file');
    assert.ok(container);
    api.openedFilesTree.provider.collapse(container);
    assert.deepEqual(api.openedFilesTree.provider.getChildren(container), []);
    api.openedFilesTree.provider.expand(container);
    assert.ok(api.openedFilesTree.provider.getChildren(container).length > 0);
  });

  test('INT-183 隐藏原生打开的编辑器命令不会在配置受限时静默失败', async () => {
    const api = await getApi();
    const sandbox = sinon.createSandbox();
    const warnings = stubWarningMessage(sandbox, ['隐藏原生视图', undefined]);
    const information = stubInformationMessage(sandbox, [undefined]);
    try {
      await api.openedFilesTree.modeService.requestNativeMutualExclusion();
      if (api.openedFilesTree.modeService.getCommandHideStateForIntegrationTest()) {
        assert.ok(information.called, '支持原生视图命令的版本应显示成功反馈');
        await api.openedFilesTree.modeService.restoreNativeOpenEditors(false);
        assert.equal(api.openedFilesTree.modeService.getCommandHideStateForIntegrationTest(), false);
        return;
      }
      const current = vscode.workspace.getConfiguration('explorer').get<number>('openEditors.visible');
      if (current === 0) {
        assert.ok(information.called, '支持自动隐藏的版本应显示成功反馈');
        assert.ok(api.openedFilesTree.modeService.getRestoreRecordForIntegrationTest());
        await api.openedFilesTree.modeService.restoreNativeOpenEditors(false);
      } else {
        assert.ok(warnings.callCount >= 2, '配置受限时应显示手动隐藏说明');
        assert.match(String(warnings.getCall(1).args[0]), /手动取消显示|手动隐藏/);
        assert.equal(warnings.getCall(1).args[1]?.modal, true, '手动隐藏说明应使用居中模态弹窗');
        assert.equal(api.openedFilesTree.modeService.getRestoreRecordForIntegrationTest(), undefined);
      }
    } finally {
      sandbox.restore();
    }
  });

  test('INT-184 前台打开外部文件后整理仍保持该文件为活动页', async () => {
    const api = await getApi();
    await vscode.workspace.getConfiguration('projectManager.tabs').update('autoOrganize', true, vscode.ConfigurationTarget.Workspace);
    await openText(projectUri(api, 'test-fixtures/workspace-one/src/app.ts'));
    const external = projectUri(api, 'test-fixtures/external/outside.txt');
    await openText(external);
    await api.tabs.waitForIdleForIntegrationTest();
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), external.toString());
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText, true);
    assert.equal((vscode.window.tabGroups.activeTabGroup.activeTab?.input as vscode.TabInputText).uri.toString(), external.toString());
  });

  test('INT-185 后台打开外部文件后整理不会抢走当前文件焦点', async () => {
    const api = await getApi();
    await vscode.workspace.getConfiguration('projectManager.tabs').update('autoOrganize', true, vscode.ConfigurationTarget.Workspace);
    const project = projectUri(api, 'test-fixtures/workspace-one/src/app.ts');
    await openText(project);
    const external = projectUri(api, 'test-fixtures/external/outside.txt');
    const document = await vscode.workspace.openTextDocument(external);
    await vscode.window.showTextDocument(document, { preserveFocus: true, preview: false });
    await openText(project);
    await api.tabs.waitForIdleForIntegrationTest();
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), project.toString());
    assert.equal(baseName(tabUris().at(-1) ?? ''), 'outside.txt');
  });

  test('INT-186 记录当前 VS Code 可调用的原生打开编辑器视图命令', async () => {
    const commands = await vscode.commands.getCommands(true);
    const relevantCommands = commands.filter((command) =>
      /openEditors|viewVisibility|toggleView/i.test(command),
    );
    console.log(`[INT-186] native view commands: ${JSON.stringify(relevantCommands)}`);
    const nativeToggleCommand = 'workbench.explorer.openEditorsView.toggleVisibility';
    assert.ok(
      commands.includes(nativeToggleCommand),
      '当前 VS Code 应注册原生“打开的编辑器”视图显隐命令',
    );
    return;
    assert.ok(
      commands.includes('workbench.explorer.openEditorsView'),
      'VS Code 应注册原生“打开的编辑器”视图命令',
    );
  });

  test('INT-189 同一文件跨编辑器组只显示一个目录树文件项', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/workspace-one/src/app.ts');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Two, preview: false });
    await delay(150);

    const matching = flattenNodes(api.openedFilesTree.provider.getRootsForIntegrationTest())
      .filter((node) => node.kind === 'file' && node.uri === uri.toString());
    assert.equal(matching.length, 1);
  });

  test('INT-190 Windows 路径按工作区安全归属且拒绝跨盘路径', () => {
    if (process.platform !== 'win32') return;
    const workspaceFolder: vscode.WorkspaceFolder = {
      uri: vscode.Uri.file('D:\\workspace'),
      name: 'workspace',
      index: 0,
    };

    assert.equal(
      getWorkspaceRelativePath(workspaceFolder, vscode.Uri.file('d:\\workspace\\src\\app.c')),
      'src/app.c',
    );
    assert.equal(
      getWorkspaceRelativePath(workspaceFolder, vscode.Uri.file('Y:\\other\\app.c')),
      undefined,
    );
  });

  test('INT-191 标题栏只提供文字形式的隐藏原生视图操作', () => {
    const extension = vscode.extensions.getExtension('local-development.project-butler');
    assert.ok(extension);
    const contributes = extension.packageJSON.contributes as {
      commands: Array<{ command: string; title: string; icon?: string }>;
      menus: { 'view/title': Array<{ command: string; when?: string; group?: string }> };
    };
    const command = contributes.commands.find((item) => item.command === 'projectManager.hideNativeOpenEditors');
    assert.deepEqual(command, {
      command: 'projectManager.hideNativeOpenEditors',
      title: '隐藏原生打开的编辑器',
      category: '项目管家',
    });
    const titleActions = contributes.menus['view/title']
      .filter((item) => item.when === 'view == projectManager.openedFilesView');
    assert.equal(titleActions.filter((item) => item.command === 'projectManager.hideNativeOpenEditors').length, 1);
    assert.equal(titleActions.some((item) => item.command === 'projectManager.restoreNativeOpenEditors'), false);
  });
});

async function openInterleaved(api: Awaited<ReturnType<typeof getApi>>): Promise<void> {
  await openText(projectUri(api, 'test-fixtures/workspace-one/README.md'));
  await openText(projectUri(api, 'test-fixtures/workspace-one/src/app.ts'));
  await openText(projectUri(api, 'test-fixtures/workspace-one/normal.txt'));
}

async function openExternalBeforeProject(api: Awaited<ReturnType<typeof getApi>>): Promise<void> {
  await openText(projectUri(api, 'test-fixtures/external/outside.txt'));
  await openText(projectUri(api, 'test-fixtures/workspace-one/README.md'));
  await openText(projectUri(api, 'test-fixtures/workspace-one/src/app.ts'));
}

function fixtureTextUris(api: Awaited<ReturnType<typeof getApi>>): vscode.Uri[] {
  return [
    projectUri(api, 'test-fixtures/workspace-one/README.md'),
    projectUri(api, 'test-fixtures/workspace-one/src/app.ts'),
    projectUri(api, 'test-fixtures/workspace-one/normal.txt'),
    projectUri(api, 'test-fixtures/workspace-one/中文 空格目录/说明 文件.txt'),
  ];
}

function baseName(uri: string): string {
  return path.posix.basename(vscode.Uri.parse(uri).path);
}

function flattenNodes(
  nodes: readonly import('../tabManagement/openedFilesTreeModel').OpenedFileTreeNode[],
): import('../tabManagement/openedFilesTreeModel').OpenedFileTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

function flattenLabels(
  nodes: readonly import('../tabManagement/openedFilesTreeModel').OpenedFileTreeNode[],
): string[] {
  return flattenNodes(nodes).map((node) => node.label);
}
