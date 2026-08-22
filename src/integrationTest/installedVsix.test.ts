import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createEmptyCatalogLibrary } from '../projectCatalog/catalogStore';
import type { ProjectButlerApi } from '../testing/projectButlerApi';

const EXTENSION_ID = 'local-development.project-butler';

suite('已安装 VSIX', () => {
  test('INT-158 隔离环境安装 VSIX 后扩展标识、版本和激活正确', async () => {
    const extension = vscode.extensions.getExtension<ProjectButlerApi>(EXTENSION_ID);
    assert.ok(extension);
    assert.equal(extension.packageJSON.version, '0.10.0');
    const api = await extension.activate();
    assert.equal(api.context.extensionMode, vscode.ExtensionMode.Production);
    assert.ok(api.catalogs.service);
  });

  test('INT-159 已安装扩展在空集合状态显示首次使用入口', async () => {
    const extension = vscode.extensions.getExtension<ProjectButlerApi>(EXTENSION_ID)!;
    const api = await extension.activate();
    await api.catalogs.service.replaceLibraryForIntegrationTest(createEmptyCatalogLibrary());
    assert.equal(api.catalogs.service.catalogs.length, 0);
    assert.match(api.catalogs.projectView.message ?? '', /添加项目|请选择/);
  });

  test('INT-160 已安装扩展重载服务状态不产生重复命令', async () => {
    const extension = vscode.extensions.getExtension<ProjectButlerApi>(EXTENSION_ID)!;
    const api = await extension.activate();
    const before = (await vscode.commands.getCommands(true)).filter((command) => command.startsWith('projectManager.'));
    await api.catalogs.service.refresh();
    const after = (await vscode.commands.getCommands(true)).filter((command) => command.startsWith('projectManager.'));
    assert.deepEqual(after.sort(), before.sort());
    assert.equal(new Set(after).size, after.length);
  });
});
