import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { applyPersonalSettingValue } from '../configuration/configurationTreeProvider';
import { closeAllEditors, delay, getApi, openText, projectUri } from './helpers';

suite('工作区外文件识别与提醒', () => {
  setup(async () => {
    await closeAllEditors();
    await applyPersonalSettingValue('externalEnabled', true);
    await applyPersonalSettingValue('externalColor', true);
    await applyPersonalSettingValue('externalBadge', true);
    await applyPersonalSettingValue('externalStatus', true);
  });

  test('INT-117 工作区内文件不产生外部装饰', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/workspace-one/src/app.ts');
    assert.equal(api.externalFiles.isExternalFileForIntegrationTest(uri), false);
    assert.equal(api.externalFiles.provideFileDecoration(uri), undefined);
  });

  test('INT-118 工作区外普通文件产生醒目装饰和状态栏文本', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/external/outside.txt');
    await openText(uri);
    await delay(100);
    const decoration = api.externalFiles.provideFileDecoration(uri);
    assert.equal(decoration?.badge, '‼');
    assert.ok(decoration?.color instanceof vscode.ThemeColor);
    const statusBarText = api.externalFiles.getStatusBarStateForIntegrationTest().text;
    assert.match(statusBarText, /^\$\(warning\) 工作区外/);
    assert.doesNotMatch(statusBarText, /‼|\$\(error\)/);
  });

  test('INT-119 外部提醒总开关统一停止识别', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/external/outside.txt');
    await applyPersonalSettingValue('externalEnabled', false);
    assert.equal(api.externalFiles.isExternalFileForIntegrationTest(uri), false);
    assert.equal(api.externalFiles.provideFileDecoration(uri), undefined);
  });

  test('INT-120 前景色开关只移除装饰颜色', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/external/outside.txt');
    await applyPersonalSettingValue('externalColor', false);
    const decoration = api.externalFiles.provideFileDecoration(uri);
    assert.equal(decoration?.badge, '‼');
    assert.equal(decoration?.color, undefined);
  });

  test('INT-121 徽标开关只移除双感叹号', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/external/outside.txt');
    await applyPersonalSettingValue('externalBadge', false);
    const decoration = api.externalFiles.provideFileDecoration(uri);
    assert.equal(decoration?.badge, undefined);
    assert.ok(decoration?.color instanceof vscode.ThemeColor);
  });

  test('INT-122 状态栏开关不改变文件装饰', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/external/outside.txt');
    await openText(uri);
    await applyPersonalSettingValue('externalStatus', false);
    await delay(100);
    assert.equal(api.externalFiles.provideFileDecoration(uri)?.badge, '‼');
  });

  test('INT-123 已打开外部文件列表可以作为查看命令数据源', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/external/outside.txt');
    await openText(uri);
    const files = api.externalFiles.getOpenExternalFiles();
    assert.ok(files.some((candidate) => candidate.toString() === uri.toString()));
    assert.ok((await vscode.commands.getCommands(true)).includes('projectManager.showExternalFiles'));
  });

  test('INT-124 诊断依据能区分工作区内和工作区外文件', async () => {
    const api = await getApi();
    const internal = projectUri(api, 'test-fixtures/workspace-one/normal.txt');
    const external = projectUri(api, 'test-fixtures/external/outside.txt');
    assert.equal(api.externalFiles.isExternalFileForIntegrationTest(internal), false);
    assert.equal(api.externalFiles.isExternalFileForIntegrationTest(external), true);
    assert.ok((await vscode.commands.getCommands(true)).includes('projectManager.diagnoseActiveFile'));
  });

  test('INT-125 当前工作区根内的深层文件不被误报', async () => {
    const api = await getApi();
    const nested = projectUri(api, 'test-fixtures/workspace-one/中文 空格目录/说明 文件.txt');
    assert.ok(vscode.workspace.getWorkspaceFolder(nested));
    assert.equal(api.externalFiles.isExternalFileForIntegrationTest(nested), false);
  });

  test('INT-126 非文件编辑器不进入外部文本文件集合', async () => {
    const api = await getApi();
    await vscode.commands.executeCommand('workbench.action.openSettings');
    await delay(100);
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText, false);
    assert.equal(api.externalFiles.getOpenExternalFiles().length, 0);
  });

  test('INT-127 关闭外部文件后从外部集合移除', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/external/outside.txt');
    await openText(uri);
    assert.equal(api.externalFiles.getOpenExternalFiles().length, 1);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await delay(100);
    assert.equal(api.externalFiles.getOpenExternalFiles().length, 0);
  });

  test('INT-128 配置变化后重新判断已打开外部文件', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/external/outside.txt');
    await openText(uri);
    assert.equal(api.externalFiles.getOpenExternalFiles().length, 1);
    await applyPersonalSettingValue('externalEnabled', false);
    await delay(100);
    assert.equal(api.externalFiles.getOpenExternalFiles().length, 0);
    await applyPersonalSettingValue('externalEnabled', true);
    assert.equal(api.externalFiles.getOpenExternalFiles().length, 1);
  });
});
