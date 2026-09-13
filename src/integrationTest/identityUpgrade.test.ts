import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { ProjectButlerApi } from '../testing/projectButlerApi';
import { createStoredCatalog } from '../projectCatalog/catalogStore';
import { OLD_EXTENSION_ID, NEW_EXTENSION_ID, MIGRATION_PENDING_KEY } from '../migration/identityMigration';

suite('已安装旧身份到正式身份的实际迁移', () => {
  test('UPGRADE-001 按阶段验证旧版导出、正式版暂存和新进程恢复', async () => {
    const phase = process.env.CATLAS_MIGRATION_TEST_PHASE;
    const directory = process.env.CATLAS_MIGRATION_TEST_DIRECTORY;
    assert.ok(directory);
    const id = phase === 'export' ? OLD_EXTENSION_ID : NEW_EXTENSION_ID;
    const extension = vscode.extensions.getExtension<ProjectButlerApi>(id);
    assert.ok(extension, `未加载预期扩展 ${id}`);
    const api = await extension.activate();
    await api.catalogs.initialization;
    assert.equal(api.context.extensionMode, vscode.ExtensionMode.Production);
    const uri = vscode.Uri.file(path.join(directory, 'identity.catlas-migration.json'));
    const sandbox = sinon.createSandbox();
    // VS Code 为每个扩展分配 API 对象，必须拦截被测安装包的对话框而非测试扩展的对象。
    const installedVscode = createRequire(path.join(extension.extensionPath, 'dist/extension.js'))('vscode') as typeof vscode;
    try {
      sandbox.stub(installedVscode.window, 'showErrorMessage').callsFake(async (message) => { assert.fail(String(message)); });
      sandbox.stub(installedVscode.window, 'showInformationMessage').resolves(undefined);
      if (phase === 'export') {
        const root = vscode.workspace.workspaceFolders![0]!.uri.toString();
        const catalog = createStoredCatalog('迁移验收集合', [{ alias: '迁移验收项目', uri: root, type: 'folder' }]);
        await api.catalogs.service.replaceLibraryForIntegrationTest({ storageVersion: 3, catalogs: [catalog] }, catalog.id);
        assert.ok(api.context.globalState.get('projectManager.catalogLibrary.v1'), '建立集合后必须已写入真实全局存储');
        await api.context.workspaceState.update('projectManager.exclusionConsolidationSnapshots.v1', [
          { folderUri: root, parentPattern: 'samples/**', entries: [{ targetId: 'search', pattern: 'samples/sub/**', value: true }] },
        ]);
        sandbox.stub(installedVscode.window, 'showWarningMessage').resolves('选择保存位置' as never);
        sandbox.stub(installedVscode.window, 'showSaveDialog').resolves(uri);
        await vscode.commands.executeCommand('projectManager.exportIdentityMigration');
        assert.ok((await vscode.workspace.fs.stat(uri)).size > 0);
        const exported = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
        assert.ok(exported.global['projectManager.catalogLibrary.v1'], '旧版导出必须包含完整集合');
      } else if (phase === 'import') {
        assert.equal(api.catalogs.service.catalogs.length, 0, '正式身份不得自动读取旧身份数据库');
        sandbox.stub(installedVscode.window, 'showOpenDialog').resolves([uri]);
        sandbox.stub(installedVscode.window, 'showWarningMessage').resolves('导入全部状态' as never);
        await vscode.commands.executeCommand('projectManager.importIdentityMigration');
        assert.ok(api.context.workspaceState.get(MIGRATION_PENDING_KEY));
        assert.equal(api.catalogs.service.catalogs.length, 0, '暂存阶段不能直接替换运行集合');
      } else {
        assert.equal(phase, 'verify');
        assert.equal(api.catalogs.service.catalogs[0]?.name, '迁移验收集合');
        assert.equal(api.catalogs.service.catalogs[0]?.projects[0]?.alias, '迁移验收项目');
        assert.ok(api.context.workspaceState.get('projectManager.exclusionConsolidationSnapshots.v1'));
        assert.equal(api.context.workspaceState.get(MIGRATION_PENDING_KEY), undefined);
        assert.equal(api.catalogs.service.current?.name, '迁移验收集合');
      }
    } finally { sandbox.restore(); }
  });
});
