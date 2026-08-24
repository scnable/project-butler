import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { createStoredCatalog } from '../projectCatalog/catalogStore';
import { closeAllEditors, createCatalogForWorkspace, getApi, openText, projectUri, seedCatalogs } from './helpers';

suite('构建、错误隔离、安全与性能', () => {
  test('INT-155 TypeScript、单元和集成测试门禁脚本完整', async () => {
    const api = await getApi();
    const packageText = new TextDecoder().decode(await vscode.workspace.fs.readFile(projectUri(api, 'package.json')));
    const manifest = JSON.parse(packageText) as { scripts: Record<string, string> };
    assert.ok(manifest.scripts.check);
    assert.ok(manifest.scripts['test:unit']);
    assert.ok(manifest.scripts['test:integration']);
    assert.ok(manifest.scripts['test:all']);
  });

  test('INT-156 Manifest 贡献命令与运行时命令一致', async () => {
    const extension = vscode.extensions.getExtension('local-development.project-butler');
    assert.ok(extension);
    const contributed = (extension.packageJSON.contributes.commands as Array<{ command: string }>).map((item) => item.command);
    const runtime = new Set(await vscode.commands.getCommands(true));
    for (const command of contributed) assert.ok(runtime.has(command), `命令未注册：${command}`);
  });

  test('INT-157 VSIX 内容规则排除源码、测试、夹具和缓存', async () => {
    const api = await getApi();
    const ignore = new TextDecoder().decode(await vscode.workspace.fs.readFile(projectUri(api, '.vscodeignore')));
    for (const rule of ['.github/**', 'node_modules/**', '.local-tools/**', 'src/**', 'scripts/**', 'test-fixtures/**', 'dist/integrationTest/**', '**/*.test.js', '.vscode-test.*']) {
      assert.match(ignore, new RegExp(escapeRegExp(rule)));
    }
    const packageText = new TextDecoder().decode(await vscode.workspace.fs.readFile(projectUri(api, 'package.json')));
    const manifest = JSON.parse(packageText) as { scripts?: Record<string, string> };
    const packageCommand = manifest.scripts?.['package:vsix'];
    assert.ok(packageCommand, 'package.json 必须声明 package:vsix');
    const outputMatch = /--out\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(packageCommand);
    const vsixRelativePath = outputMatch?.slice(1).find((value): value is string => value !== undefined);
    assert.ok(vsixRelativePath, 'package:vsix 必须通过 --out 声明候选包路径');
    const vsix = projectUri(api, vsixRelativePath.replaceAll('\\', '/'));
    assert.ok((await vscode.workspace.fs.stat(vsix)).size > 0);
    const { stdout } = await promisify(execFile)('tar.exe', ['-tf', vsix.fsPath]);
    const entries = stdout.split(/\r?\n/u).filter(Boolean);
    const forbidden = [
      'extension/src/',
      'extension/test-fixtures/',
      'extension/.local-tools/',
      'extension/node_modules/',
      'extension/scripts/',
      'extension/dist/integrationTest/',
      'extension/dist/testing/',
    ];
    for (const prefix of forbidden) {
      assert.equal(entries.some((entry) => entry.startsWith(prefix)), false, `VSIX 不应包含：${prefix}`);
    }
    assert.equal(entries.some((entry) => entry.endsWith('.test.js')), false);
  });

  test('INT-161 损坏内部存储不会导致服务整体失效', async () => {
    const api = await getApi();
    await api.context.globalState.update('projectManager.catalogLibrary.v1', { storageVersion: 999, catalogs: 'broken' });
    await api.catalogs.service.initialize();
    assert.deepEqual(api.catalogs.service.catalogs, []);
    assert.ok((await vscode.commands.getCommands(true)).includes('projectManager.addProjectToCatalog'));
    const catalog = createCatalogForWorkspace('恢复安全集合');
    await seedCatalogs(api, [catalog], catalog.id);
  });

  test('INT-162 标签和大纲操作不改变文本内容', async () => {
    const api = await getApi();
    await closeAllEditors();
    const uri = projectUri(api, 'test-fixtures/workspace-one/src/app.ts');
    const document = await vscode.workspace.openTextDocument(uri);
    const before = document.getText();
    await openText(uri);
    await api.tabs.organizeCurrentGroup(false);
    await api.outline.refreshSymbols('安全检查');
    assert.equal(document.getText(), before);
    assert.equal(document.isDirty, false);
  });

  test('INT-163 具有删除或重命名语义的命令均限定到安全对象', () => {
    const extension = vscode.extensions.getExtension('local-development.project-butler')!;
    const commands = (extension.packageJSON.contributes.commands as Array<{ command: string }>).map((item) => item.command.toLocaleLowerCase());
    const allowedScopedMutationCommands = new Set([
      'projectmanager.renamecatalog',
      'projectmanager.renameprojectalias',
      'projectmanager.removeprojectfromcatalog',
      'projectmanager.todo.removemark',
    ]);
    const unsafeCommands = commands.filter((command) => /delete|remove|rename|movefile/.test(command)
      && !allowedScopedMutationCommands.has(command));
    assert.deepEqual(unsafeCommands, []);
  });

  test('INT-164 输出日志实现不包含账号令牌和文件内容输出', async () => {
    const api = await getApi();
    const sourceFiles = [
      'src/extension.ts',
      'src/projectCatalog/catalogServiceV2.ts',
      'src/exclusions/exclusionServiceV2.ts',
      'src/externalFiles/externalFileMonitor.ts',
      'src/symbolOutline/symbolOutlineViewProvider.ts',
      'src/tabManagement/tabManagementService.ts',
    ];
    for (const file of sourceFiles) {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(projectUri(api, file)));
      assert.doesNotMatch(text, /output\.appendLine\([^\n]*(token|password|secret|document\.getText)/i);
    }
  });

  test('INT-165 并发刷新与配置事件在性能基线内完成', async () => {
    const api = await getApi();
    await openText(projectUri(api, 'test-fixtures/workspace-one/src/outline-sample.ts'));
    const started = Date.now();
    for (let index = 0; index < 20; index += 1) {
      await Promise.all([api.catalogs.service.refresh(), api.outline.refreshSymbols(`性能-${index}`)]);
    }
    assert.ok(Date.now() - started < 10_000);
    assert.ok(api.catalogs.service.configurationRevision >= 0);
  });

  test('INT-223 CI 对推送和拉取请求执行只读全量门禁', async () => {
    const api = await getApi();
    const workflow = new TextDecoder().decode(await vscode.workspace.fs.readFile(
      projectUri(api, '.github/workflows/ci.yml'),
    ));
    assert.match(workflow, /push:/u);
    assert.match(workflow, /pull_request:/u);
    assert.match(workflow, /workflow_dispatch:/u);
    assert.match(workflow, /contents:\s*read/u);
    assert.doesNotMatch(workflow, /contents:\s*write/u);
    for (const command of ['npm ci --ignore-scripts', 'npm run check', 'npm run test:unit', 'npm run package:vsix']) {
      assert.match(workflow, new RegExp(escapeRegExp(command)));
    }
    assert.match(workflow, /--label extensionHost/u);
    assert.match(workflow, /--label installedCandidate/u);
    assert.match(workflow, /persist-credentials:\s*false/u);
    assert.match(workflow, /require\('\.\/package\.json'\)\.version/u);
    assert.match(workflow, /PROJECT_BUTLER_TEST_VSIX=\$packagePath/u);
    assert.doesNotMatch(workflow, /project-butler-0\.10\.0-preview-test\.vsix/u);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
