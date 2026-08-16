import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { applyPersonalSettingValue } from '../configuration/configurationTreeProvider';
import { closeAllEditors, getApi } from './helpers';

const EXTENSION_ID = 'local-development.project-butler';

suite('项目管家 Extension Host 集成测试', () => {
  suiteTeardown(async () => {
    // 测试使用隔离的用户数据目录，仍将显式值恢复为安全的开启状态。
    await applyPersonalSettingValue('disableAiFeatures', false);
    await closeAllEditors();
  });

  test('INT-001 在真实扩展宿主中激活并注册核心命令', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `未找到扩展：${EXTENSION_ID}`);

    const api = await getApi();
    assert.equal(extension.isActive, true);
    assert.ok(api.catalogs.configurationProvider);

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'projectManager.configurePersonalSetting',
      'projectManager.organizeCurrentTabGroup',
      'projectManager.refreshSymbolOutline',
    ]) {
      assert.ok(commands.includes(command), `命令未注册：${command}`);
    }

    const views = extension.packageJSON.contributes?.views?.projectManager as Array<{ id?: string }> | undefined;
    assert.ok(views?.some((view) => view.id === 'projectManager.configurationView'), '配置视图未贡献');
    assert.ok(views?.some((view) => view.id === 'projectManager.symbolOutlineView'), '增强函数大纲视图未贡献');
  });

  test('INT-002 使用真实 VS Code API 打开源码并刷新增强函数大纲', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, '集成测试工作区未打开');

    const sourceUri = vscode.Uri.joinPath(workspaceFolder.uri, 'src', 'app.ts');
    const document = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(document, { preview: false });

    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), sourceUri.toString());
    await vscode.commands.executeCommand('projectManager.refreshSymbolOutline');
  });

  test('INT-003 写入用户级 AI 开关并识别工作区覆盖', async () => {
    const configuration = vscode.workspace.getConfiguration('chat');
    assert.equal(configuration.inspect<boolean>('disableAIFeatures')?.workspaceValue, false);

    const changed = waitForConfigurationChange('chat.disableAIFeatures');
    const disabled = await applyPersonalSettingValue('disableAiFeatures', true);
    await changed;

    assert.equal(disabled.globalValue, true);
    assert.equal(disabled.effectiveValue, false);
    assert.equal(disabled.overridden, true);
    assert.equal(configuration.inspect<boolean>('disableAIFeatures')?.globalValue, true);

    const enabled = await applyPersonalSettingValue('disableAiFeatures', false);
    assert.equal(enabled.globalValue, false);
    assert.equal(enabled.effectiveValue, false);
    assert.equal(enabled.overridden, false);
  });
});

function waitForConfigurationChange(section: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      disposable.dispose();
      reject(new Error(`等待配置变化超时：${section}`));
    }, 10_000);
    const disposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(section)) return;
      clearTimeout(timeout);
      disposable.dispose();
      resolve();
    });
  });
}
