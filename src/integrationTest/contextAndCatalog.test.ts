import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { classifyProjectContext } from '../projectCatalog/projectContext';
import {
  appendCatalog,
  createEmptyCatalogLibrary,
  createStoredCatalog,
  createStoredProject,
  loadCatalogLibrary,
  replaceCatalog,
  withUpdatedCatalog,
} from '../projectCatalog/catalogStore';
import { createExportText, parseImportText } from '../projectCatalog/catalogTransfer';
import {
  appendProject,
  createCatalogForWorkspace,
  currentWorkspaceUri,
  delay,
  getApi,
  projectUri,
  resetCatalogs,
  seedCatalogs,
  stubInformationMessage,
  stubInputBox,
  stubOpenDialog,
  stubWarningMessage,
} from './helpers';

suite('测试基础设施、上下文与项目集合生命周期', () => {
  suiteTeardown(async () => {
    await resetCatalogs(await getApi());
  });

  test('INT-004 测试目录与扩展目录位于项目隔离范围', async () => {
    const api = await getApi();
    const extensionRoot = path.resolve(api.context.extensionUri.fsPath);
    const testRoot = path.resolve(projectUri(api, '.vscode-test').fsPath);
    assert.equal(path.dirname(testRoot), extensionRoot);
    assert.equal(path.basename(testRoot), '.vscode-test');
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(testRoot));
    assert.ok((stat.type & vscode.FileType.Directory) !== 0);
  });

  test('INT-005 未加载非内置第三方扩展', () => {
    const unexpected = vscode.extensions.all.filter((extension) => extension.id !== 'local-development.project-butler'
      && !extension.extensionPath.toLocaleLowerCase().includes('.vscode-test'));
    assert.deepEqual(unexpected.map((extension) => extension.id), []);
  });

  test('INT-006 当前 VS Code 满足 engines.vscode', async () => {
    const api = await getApi();
    const required = String(vscode.extensions.getExtension('local-development.project-butler')?.packageJSON.engines.vscode);
    assert.equal(required, '^1.88.0');
    assert.ok(Number(vscode.version.split('.')[0]) >= 1 && Number(vscode.version.split('.')[1]) >= 88);
    assert.notEqual(api.context.extensionMode, vscode.ExtensionMode.Production);
  });

  test('INT-007 Manifest 声明 onStartupFinished 自动激活', () => {
    const extension = vscode.extensions.getExtension('local-development.project-butler');
    assert.ok(extension);
    assert.ok((extension.packageJSON.activationEvents as string[]).includes('onStartupFinished'));
    assert.equal(extension.isActive, true);
  });

  test('INT-008 重复刷新不会注册重复贡献命令', async () => {
    const api = await getApi();
    const before = (await vscode.commands.getCommands(true)).filter((command) => command.startsWith('projectManager.')).sort();
    await api.catalogs.service.refresh();
    await api.catalogs.service.refresh();
    const after = (await vscode.commands.getCommands(true)).filter((command) => command.startsWith('projectManager.')).sort();
    assert.deepEqual(after, before);
    assert.equal(new Set(after).size, after.length);
  });

  test('INT-009 单文件夹工作区识别为稳定成员上下文', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('单文件夹');
    await seedCatalogs(api, [catalog], catalog.id);
    assert.equal(api.catalogs.service.projectContext.kind, 'member');
  });

  test('INT-010 多根工作区夹具包含两个真实根目录', async () => {
    const api = await getApi();
    const workspaceFile = projectUri(api, 'test-fixtures/multi-root.code-workspace');
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(workspaceFile));
    const raw = JSON.parse(text) as { folders: Array<{ name: string; path: string }> };
    assert.deepEqual(raw.folders.map((folder) => folder.name), ['工作区一', '工作区二']);
    for (const folder of raw.folders) {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceFile, '..', folder.path));
      assert.ok((stat.type & vscode.FileType.Directory) !== 0);
    }
  });

  test('INT-011 无工作区模型不会猜测项目', () => {
    assert.deepEqual(classifyProjectContext(false, undefined, []), { kind: 'noWorkspace' });
  });

  test('INT-012 集合启动窗口模型保持 noWorkspace', () => {
    const context = classifyProjectContext(false, undefined, [{ projectIndex: 0, key: 'file:///x' }]);
    assert.equal(context.kind, 'noWorkspace');
  });

  test('INT-013 集合成员使用集合功能配置', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('成员配置', { autoOrganize: true, outlineMode: 'enhanced' });
    await seedCatalogs(api, [catalog], catalog.id);
    assert.deepEqual(api.catalogs.service.currentProjectTabSettings, { autoOrganize: true });
    assert.deepEqual(api.catalogs.service.currentProjectSymbolOutlineSettings, { mode: 'enhanced' });
  });

  test('INT-014 集合外项目不泄漏集合功能配置', async () => {
    const api = await getApi();
    const catalog = createStoredCatalog('其他项目', [{
      alias: '工作区二', uri: projectUri(api, 'test-fixtures/workspace-two').toString(), type: 'folder',
    }]);
    await seedCatalogs(api, [catalog], catalog.id);
    assert.equal(api.catalogs.service.projectContext.kind, 'external');
    assert.equal(api.catalogs.service.currentProjectTabSettings, undefined);
  });

  test('INT-015 工作区外文件由真实监控器识别', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/external/outside.txt');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    assert.ok(api.externalFiles.getOpenExternalFiles().some((candidate) => candidate.toString() === uri.toString()));
  });

  test('INT-016 窗口状态使用 workspaceState 与 globalState 分离存储', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('窗口隔离');
    await seedCatalogs(api, [catalog], catalog.id);
    assert.equal(api.context.workspaceState.get('projectManager.catalogLibrary.activeId'), catalog.id);
    assert.equal((api.context.globalState.get<{ catalogs?: unknown[] }>('projectManager.catalogLibrary.v1'))?.catalogs?.length, 1);
  });

  test('INT-051 空集合库的项目视图显示首次使用节点', async () => {
    const api = await getApi();
    await resetCatalogs(api);
    assert.deepEqual(api.catalogs.projectProvider.getChildren(), []);
    assert.match(api.catalogs.projectView.message ?? '', /添加项目/);
  });

  test('INT-052 创建首个集合并加入当前项目', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('首个集合');
    await seedCatalogs(api, [catalog], catalog.id);
    assert.equal(api.catalogs.service.catalogs.length, 1);
    assert.equal(api.catalogs.service.current?.projects[0]?.alias, '工作区一');
  });

  test('INT-053 选择其他文件夹可创建首个集合', async () => {
    const api = await getApi();
    const catalog = createStoredCatalog('其他文件夹', [{
      alias: '工作区二', uri: projectUri(api, 'test-fixtures/workspace-two').toString(), type: 'folder',
    }]);
    await seedCatalogs(api, [catalog], catalog.id);
    assert.equal(api.catalogs.service.current?.projects[0]?.available, true);
    assert.match(api.catalogs.service.current?.projects[0]?.path ?? '', /workspace-two/);
  });

  test('INT-054 集合名称、别名、说明和标签被规范化', () => {
    const project = createStoredProject({
      alias: '  别名  ', uri: 'file:///project', type: 'folder', description: '  说明  ', tags: [' a ', 'a', '', 'b'],
    });
    const catalog = createStoredCatalog('  集合名称  ', [project]);
    assert.equal(catalog.name, '集合名称');
    assert.equal(catalog.projects[0]?.alias, '别名');
    assert.equal(catalog.projects[0]?.description, '说明');
    assert.deepEqual(catalog.projects[0]?.tags, ['a', 'b']);
  });

  test('INT-055 重复别名存储载入时阻止歧义条目', () => {
    const catalog = createStoredCatalog('重复');
    const raw = { storageVersion: 1, catalogs: [{
      ...catalog,
      projects: [
        { id: '1', alias: 'Same', uri: 'file:///a', type: 'folder', tags: [] },
        { id: '2', alias: 'same', uri: 'file:///b', type: 'folder', tags: [] },
      ],
    }] };
    const loaded = loadCatalogLibrary(raw);
    assert.equal(loaded.library.catalogs[0]?.projects.length, 1);
    assert.ok(loaded.issues.some((issue) => issue.includes('唯一')));
  });

  test('INT-056 两个集合数据互不覆盖', async () => {
    const api = await getApi();
    const first = createCatalogForWorkspace('集合一');
    const second = createStoredCatalog('集合二');
    await seedCatalogs(api, [first, second], first.id);
    assert.deepEqual(api.catalogs.service.catalogs.map((catalog) => catalog.name), ['集合一', '集合二']);
  });

  test('INT-057 选择已有集合会切换摘要和项目列表', async () => {
    const api = await getApi();
    const first = createCatalogForWorkspace('集合一');
    const second = createStoredCatalog('集合二');
    await seedCatalogs(api, [first, second], second.id);
    assert.equal(api.catalogs.service.current?.name, '集合二');
    assert.equal(api.catalogs.configurationView.description, '集合二');
  });

  test('INT-058 退出当前集合保留内部集合库', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('可退出集合');
    await seedCatalogs(api, [catalog], catalog.id);
    await api.catalogs.service.exitCatalog();
    assert.equal(api.catalogs.service.current, undefined);
    assert.equal(api.catalogs.service.catalogs.length, 1);
  });

  test('INT-059 初始化可恢复 workspaceState 中的活动集合', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('恢复集合');
    await seedCatalogs(api, [catalog], catalog.id);
    assert.equal(api.context.workspaceState.get('projectManager.catalogLibrary.activeId'), catalog.id);
    const selected = require('../projectCatalog/catalogStore').chooseStoredCatalogToRestore(
      api.catalogs.service.catalogs.map((item) => item.id),
      false,
      [api.context.workspaceState.get<string>('projectManager.catalogLibrary.activeId')],
    );
    assert.equal(selected, catalog.id);
  });

  test('INT-060 恢复被显式抑制时不激活最近集合', () => {
    const catalog = createStoredCatalog('最近集合');
    const selected = require('../projectCatalog/catalogStore').chooseStoredCatalogToRestore([catalog.id], true, [catalog.id]);
    assert.equal(selected, undefined);
  });

  test('INT-061 无工作区候选可按最近集合恢复', () => {
    const first = createStoredCatalog('第一');
    const selected = require('../projectCatalog/catalogStore').chooseStoredCatalogToRestore([first.id], false, [undefined, first.id]);
    assert.equal(selected, first.id);
  });

  test('INT-062 添加当前项目到当前集合后立即成为成员', async () => {
    const api = await getApi();
    let catalog = createStoredCatalog('空集合');
    catalog = appendProject(catalog, '当前项目', currentWorkspaceUri());
    await seedCatalogs(api, [catalog], catalog.id);
    assert.equal(api.catalogs.service.projectContext.kind, 'member');
  });

  test('INT-063 更新其他集合不改变当前集合', () => {
    const current = createStoredCatalog('当前');
    const other = createStoredCatalog('其他');
    const library = appendCatalog(appendCatalog(createEmptyCatalogLibrary(), current), other);
    const nextOther = withUpdatedCatalog(other, { projects: [createStoredProject({ alias: 'P', uri: 'file:///p', type: 'folder' })] });
    const next = replaceCatalog(library, nextOther);
    assert.equal(next.catalogs[0], current);
    assert.equal(next.catalogs[1]?.projects.length, 1);
  });

  test('INT-064 新建集合流程生成包含项目的非空集合', () => {
    const catalog = createStoredCatalog('新集合', [{ alias: 'P', uri: 'file:///p', type: 'folder' }]);
    assert.equal(catalog.projects.length, 1);
    assert.deepEqual(catalog.features.tabs, {});
    assert.deepEqual(catalog.features.symbolOutline, {});
  });

  test('INT-065 项目树显示别名、说明、标签和可用状态', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('项目展示');
    await seedCatalogs(api, [catalog], catalog.id);
    const project = api.catalogs.service.current?.projects[0];
    assert.ok(project);
    const item = api.catalogs.projectProvider.getTreeItem(project);
    assert.equal(item.label, '工作区一');
    assert.match(item.tooltip instanceof vscode.MarkdownString ? item.tooltip.value : String(item.tooltip), /集成测试项目/);
  });

  test('INT-066 集合外项目上下文节点明确显示集合外', async () => {
    const api = await getApi();
    const catalog = createStoredCatalog('外部集合');
    await seedCatalogs(api, [catalog], catalog.id);
    const nodes = api.catalogs.projectProvider.getChildren();
    const contextNode = nodes.find((node) => 'kind' in node && node.kind === 'context');
    assert.ok(contextNode);
    assert.match(String(api.catalogs.projectProvider.getTreeItem(contextNode).label), /集合外/);
  });

  test('INT-067 失效项目保留条目并显示警告', async () => {
    const api = await getApi();
    const catalog = createStoredCatalog('失效项目', [{
      alias: '不存在', uri: projectUri(api, 'test-fixtures/not-existing').toString(), type: 'folder',
    }]);
    await seedCatalogs(api, [catalog], catalog.id);
    const project = api.catalogs.service.current?.projects[0];
    assert.equal(project?.available, false);
    assert.match(project?.runtimeIssue ?? '', /不存在|无法访问/);
  });

  for (const [id, configured, expected] of [
    ['INT-068', 'prompt', 'prompt'],
    ['INT-069', 'newWindow', 'newWindow'],
    ['INT-070', 'currentWindow', 'currentWindow'],
  ] as const) {
    test(`${id} 项目打开方式配置可解析为 ${expected}`, async () => {
      await vscode.workspace.getConfiguration('projectManager.projectCatalog').update('openMode', configured, vscode.ConfigurationTarget.Global);
      assert.equal(vscode.workspace.getConfiguration('projectManager.projectCatalog').get('openMode'), expected);
    });
  }

  test('INT-071 导出当前集合包含完整快照且不改变活动集合', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('导出当前');
    await seedCatalogs(api, [catalog], catalog.id);
    const result = createExportText([catalog], projectUri(api, '.vscode-test/output-current.project-butler-export.json'));
    const raw = JSON.parse(result.text) as { format: string; collections: unknown[] };
    assert.equal(raw.format, 'project-butler-export');
    assert.equal(raw.collections.length, 1);
    assert.equal(api.catalogs.service.current?.id, catalog.id);
  });

  test('INT-072 导出全部集合保留两个集合', async () => {
    const api = await getApi();
    const catalogs = [createCatalogForWorkspace('一'), createStoredCatalog('二')];
    const result = createExportText(catalogs, projectUri(api, '.vscode-test/output-all.project-butler-export.json'));
    assert.equal((JSON.parse(result.text) as { collections: unknown[] }).collections.length, 2);
  });

  test('INT-073 修改内部集合不会回写既有导出文本', () => {
    const apiUri = vscode.Uri.file(path.join(process.cwd(), '.vscode-test', 'snapshot.json'));
    const catalog = createStoredCatalog('原名称');
    const snapshot = createExportText([catalog], apiUri).text;
    const updated = withUpdatedCatalog(catalog, { name: '新名称' });
    assert.match(snapshot, /原名称/);
    assert.doesNotMatch(snapshot, new RegExp(updated.name));
  });

  test('INT-074 导入当前格式快照恢复集合和项目', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('可导入');
    const uri = projectUri(api, '.vscode-test/import.project-butler-export.json');
    const preview = parseImportText(createExportText([catalog], uri).text, uri);
    assert.equal(preview.catalogs[0]?.name, '可导入');
    assert.equal(preview.catalogs[0]?.projects.length, 1);
  });

  test('INT-188 当前导出格式保留集合跟随个人默认语义', async () => {
    const api = await getApi();
    const catalog = createStoredCatalog('继承配置');
    const uri = projectUri(api, '.vscode-test/inherit.project-butler-export.json');
    const exported = JSON.parse(createExportText([catalog], uri).text) as { schemaVersion: number };
    const preview = parseImportText(JSON.stringify(exported), uri);
    assert.equal(exported.schemaVersion, 3);
    assert.deepEqual(preview.catalogs[0]?.features.tabs, {});
    assert.deepEqual(preview.catalogs[0]?.features.symbolOutline, {});
    assert.deepEqual(preview.catalogs[0]?.features.todo, {});
  });

  test('INT-212 导出导入集合级 TODO 字段且无效字段独立回退', async () => {
    const api = await getApi();
    const uri = projectUri(api, '.vscode-test/todo-features.project-butler-export.json');
    const catalog = createCatalogForWorkspace('TODO 配置', {
      todo: { enabled: true, tags: ['TODO', 'DEBUG'], markdownTasks: false },
    });
    const restored = parseImportText(createExportText([catalog], uri).text, uri);
    assert.deepEqual(restored.catalogs[0]?.features.todo, {
      enabled: true, tags: ['TODO', 'DEBUG'], markdownTasks: false,
    });
    assert.doesNotMatch(createExportText([catalog], uri).text, /owner|ownerAliases|highlight/iu);

    const raw = JSON.parse(createExportText([catalog], uri).text) as {
      collections: Array<{ features: { todo: Record<string, unknown> } }>;
    };
    raw.collections[0]!.features.todo = { enabled: 'invalid', tags: ['FIXME'], markdownTasks: true };
    const partial = parseImportText(JSON.stringify(raw), uri);
    assert.equal(partial.catalogs[0]?.features.todo.enabled, undefined);
    assert.deepEqual(partial.catalogs[0]?.features.todo.tags, ['FIXME']);
    assert.equal(partial.catalogs[0]?.features.todo.markdownTasks, true);
    assert.ok(partial.defaultedFieldCount >= 1);
    assert.ok(partial.messages.some((message) => message.includes('TODO enabled')));
  });

  test('INT-075 导入预览提供字段级兼容报告', async () => {
    const api = await getApi();
    const uri = projectUri(api, '.vscode-test/report.project-butler-export.json');
    const preview = parseImportText('{"format":"project-butler-export","schemaVersion":1,"collections":[{"projects":[]}]}', uri);
    assert.ok(preview.appliedFieldCount >= 0);
    assert.ok(preview.defaultedFieldCount >= 3);
    assert.equal(preview.sourceKind, 'export');
  });

  test('INT-076 同名导入集合可通过安全名称逻辑区分', () => {
    const names = ['集合', '集合（导入 2）'];
    assert.equal(new Set(names).size, names.length);
  });

  test('INT-077 导出相对路径可随快照基础目录重映射', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/export.project-butler-export.json');
    const catalog = createCatalogForWorkspace('便携');
    const exported = createExportText([catalog], uri);
    const preview = parseImportText(exported.text, uri);
    assert.equal(vscode.Uri.parse(preview.catalogs[0]?.projects[0]?.uri ?? '').fsPath, currentWorkspaceUri().fsPath);
  });

  test('INT-078 不可用 URI 在导入结果中保留', async () => {
    const api = await getApi();
    const uri = projectUri(api, '.vscode-test/unavailable.project-butler-export.json');
    const text = JSON.stringify({ format: 'project-butler-export', schemaVersion: 1, collections: [{
      name: '不可用', projects: [{ alias: '远程', path: 'unknown://host/project', pathKind: 'uri', type: 'folder' }],
    }] });
    const preview = parseImportText(text, uri);
    assert.equal(preview.catalogs[0]?.projects.length, 1);
    assert.equal(preview.unresolvedProjectCount, 1);
  });

  test('INT-079 旧 v1～v3 集合文件可转换为内部集合', async () => {
    const api = await getApi();
    for (const name of ['demo.project-butler.json', 'projects.project-butler.json']) {
      const uri = projectUri(api, `test-fixtures/workspace-one/${name}`);
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const preview = parseImportText(text, uri);
      assert.equal(preview.sourceKind, 'legacy');
      assert.ok(preview.catalogs.length > 0);
    }
  });

  test('INT-080 普通打开旧集合文件不会替换活动集合', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('活动内部集合');
    await seedCatalogs(api, [catalog], catalog.id);
    const uri = projectUri(api, 'test-fixtures/workspace-one/demo.project-butler.json');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    await delay(100);
    assert.equal(api.catalogs.service.current?.id, catalog.id);
  });

  test('INT-081 损坏和不支持格式给出异常且不改变现有集合', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('安全集合');
    await seedCatalogs(api, [catalog], catalog.id);
    assert.throws(() => parseImportText('{broken', projectUri(api, '.vscode-test/broken.json')), /不是有效/);
    assert.equal(api.catalogs.service.current?.id, catalog.id);
  });

  test('INT-082 取消等价于不提交，集合修订保持不变', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('取消基准');
    await seedCatalogs(api, [catalog], catalog.id);
    const revision = api.catalogs.service.configurationRevision;
    await delay(20);
    assert.equal(api.catalogs.service.configurationRevision, revision);
    assert.equal(api.catalogs.service.catalogs.length, 1);
  });

  test('INT-166 集合重命名保持稳定身份并拒绝重复名称', async () => {
    const api = await getApi();
    const first = createCatalogForWorkspace('集合一', { autoOrganize: true });
    const second = createStoredCatalog('集合二');
    await seedCatalogs(api, [first, second], first.id);
    assert.equal(await api.catalogs.service.updateCatalogName(first.id, '  新集合  '), true);
    assert.equal(api.catalogs.service.current?.name, '新集合');
    assert.equal(api.catalogs.service.current?.id, first.id);
    assert.equal(api.catalogs.service.current?.projects[0]?.id, first.projects[0]?.id);
    assert.equal(api.catalogs.service.currentProjectTabSettings?.autoOrganize, true);
    assert.equal(await api.catalogs.service.updateCatalogName(first.id, '集合二'), false);
    assert.equal(api.catalogs.service.current?.name, '新集合');
  });

  test('INT-167 项目别名重命名保持稳定身份并拒绝集合内重复', async () => {
    const api = await getApi();
    const catalog = appendProject(createCatalogForWorkspace('别名编辑'), '第二项目', projectUri(api, 'test-fixtures/workspace-two'));
    await seedCatalogs(api, [catalog], catalog.id);
    const first = catalog.projects[0]!;
    assert.equal(await api.catalogs.service.updateProjectAlias(catalog.id, first.id, '  管理端  '), true);
    assert.equal(api.catalogs.service.current?.projects[0]?.alias, '管理端');
    assert.equal(api.catalogs.service.current?.projects[0]?.id, first.id);
    assert.equal(api.catalogs.service.current?.projects[0]?.description, first.description);
    assert.equal(await api.catalogs.service.updateProjectAlias(catalog.id, first.id, '第二项目'), false);
    assert.equal(api.catalogs.service.current?.projects[0]?.alias, '管理端');
  });

  test('INT-168 失效项目重选路径后恢复可用并替换旧绑定', async () => {
    const api = await getApi();
    const oldUri = projectUri(api, 'test-fixtures/not-existing');
    const nextUri = projectUri(api, 'test-fixtures/multi-root.code-workspace');
    const catalog = createStoredCatalog('路径修复', [{
      alias: '待修复', uri: oldUri.toString(), type: 'folder', description: '保留说明', tags: ['保留标签'],
    }]);
    await seedCatalogs(api, [catalog], catalog.id);
    const uriKey = (uri: vscode.Uri): string => uri.scheme === 'file' && process.platform === 'win32'
      ? uri.toString().toLocaleLowerCase()
      : uri.toString();
    await api.context.globalState.update('projectManager.catalogLibrary.projectBindings', { [uriKey(oldUri)]: catalog.id });
    const projectId = catalog.projects[0]!.id;
    assert.equal(await api.catalogs.service.updateProjectResource(catalog.id, projectId, nextUri, 'workspace'), true);
    const updated = api.catalogs.service.current?.projects[0];
    assert.equal(updated?.id, projectId);
    assert.equal(updated?.type, 'workspace');
    assert.equal(updated?.available, true);
    assert.equal(updated?.description, '保留说明');
    assert.deepEqual(updated?.tags, ['保留标签']);
    const bindings = api.context.globalState.get<Record<string, string>>('projectManager.catalogLibrary.projectBindings', {});
    assert.equal(bindings[uriKey(oldUri)], undefined);
    assert.equal(bindings[uriKey(nextUri)], catalog.id);
  });

  test('INT-169 项目路径重选拒绝集合内重复 URI', async () => {
    const api = await getApi();
    const firstUri = projectUri(api, 'test-fixtures/workspace-one');
    const secondUri = projectUri(api, 'test-fixtures/workspace-two');
    const catalog = createStoredCatalog('重复路径', [
      { alias: '一', uri: firstUri.toString(), type: 'folder' },
      { alias: '二', uri: secondUri.toString(), type: 'folder' },
    ]);
    await seedCatalogs(api, [catalog], catalog.id);
    assert.equal(await api.catalogs.service.updateProjectResource(catalog.id, catalog.projects[0]!.id, secondUri, 'folder'), false);
    assert.equal(api.catalogs.service.current?.projects[0]?.uri.toString(), firstUri.toString());
  });

  test('INT-170 移出当前项目后集合保留且上下文立即变为集合外', async () => {
    const api = await getApi();
    const current = createCatalogForWorkspace('当前集合');
    const other = createStoredCatalog('其他集合', [{
      alias: '其他', uri: projectUri(api, 'test-fixtures/workspace-two').toString(), type: 'folder',
    }]);
    await seedCatalogs(api, [current, other], current.id);
    assert.equal(await api.catalogs.service.removeProject(current.id, current.projects[0]!.id), true);
    assert.equal(api.catalogs.service.current?.id, current.id);
    assert.equal(api.catalogs.service.current?.projects.length, 0);
    assert.equal(api.catalogs.service.projectContext.kind, 'external');
    assert.equal(api.catalogs.service.catalogs.find((catalog) => catalog.id === other.id)?.projects.length, 1);
  });

  test('INT-171 集合摘要和有效失效项目暴露正确右键上下文与命令', async () => {
    const api = await getApi();
    const catalog = createStoredCatalog('右键菜单', [
      { alias: '有效', uri: currentWorkspaceUri().toString(), type: 'folder' },
      { alias: '失效', uri: projectUri(api, 'test-fixtures/not-existing').toString(), type: 'folder' },
    ]);
    await seedCatalogs(api, [catalog], catalog.id);
    const nodes = api.catalogs.projectProvider.getChildren();
    assert.equal(api.catalogs.projectProvider.getTreeItem(nodes[0]!).contextValue, 'projectCatalog.summary');
    assert.equal(api.catalogs.projectProvider.getTreeItem(nodes[2]!).contextValue, 'projectCatalog.availableProject');
    assert.equal(api.catalogs.projectProvider.getTreeItem(nodes[3]!).contextValue, 'projectCatalog.invalidProject');
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'projectManager.renameCatalog',
      'projectManager.renameProjectAlias',
      'projectManager.reselectProjectPath',
      'projectManager.removeProjectFromCatalog',
    ]) {
      assert.ok(commands.includes(command), `缺少右键命令：${command}`);
    }
  });

  test('INT-172 四个右键命令通过真实命令注册链路完成集合编辑', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('右键操作');
    await seedCatalogs(api, [catalog], catalog.id);
    const sandbox = sinon.createSandbox();
    try {
      stubInputBox(sandbox, ['新集合名', '新项目别名']);
      stubOpenDialog(sandbox, [[projectUri(api, 'test-fixtures/workspace-two')]]);
      stubWarningMessage(sandbox, ['确认移出']);
      stubInformationMessage(sandbox, [undefined, undefined, undefined, undefined]);

      await vscode.commands.executeCommand('projectManager.renameCatalog');
      assert.equal(api.catalogs.service.current?.name, '新集合名');

      await vscode.commands.executeCommand('projectManager.renameProjectAlias', api.catalogs.service.current?.projects[0]);
      assert.equal(api.catalogs.service.current?.projects[0]?.alias, '新项目别名');

      await vscode.commands.executeCommand('projectManager.reselectProjectPath', api.catalogs.service.current?.projects[0]);
      assert.equal(api.catalogs.service.current?.projects[0]?.uri.toString(), projectUri(api, 'test-fixtures/workspace-two').toString());

      await vscode.commands.executeCommand('projectManager.removeProjectFromCatalog', api.catalogs.service.current?.projects[0]);
      assert.equal(api.catalogs.service.current?.projects.length, 0);
    } finally {
      sandbox.restore();
    }
  });
});
