import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { ConfigurationTreeNode } from '../configuration/configurationTreeProvider';
import { TodoIndex } from '../todo/todoIndex';
import { LocalTodoCandidateSearch } from '../todo/todoLocalSearch';
import { TodoScanner } from '../todo/todoScanner';
import { flattenTodoNodes } from './todoTestSupport';
import { closeAllEditors, createCatalogForWorkspace, currentWorkspaceUri, delay, getApi, openText, projectUri, resetCatalogs, seedCatalogs, setGlobalSetting, setWorkspaceSetting, stubInputBox, stubQuickPick, waitUntil } from './helpers';

suite('代码 TODO 聚合、导航与快速标记', () => {
  const sandbox = sinon.createSandbox();

  setup(async () => {
    await setGlobalSetting('projectManager.todo', 'enabled', true);
    await setGlobalSetting('projectManager.todo', 'tags', ['TODO', 'FIXME', 'BUG', 'HACK', 'XXX']);
    await setGlobalSetting('projectManager.todo', 'markdownTasks', true);
    await setGlobalSetting('projectManager.todo', 'highlight', true);
    await setGlobalSetting('projectManager.todo', 'owner', 'scnable-test');
    await setGlobalSetting('projectManager.todo', 'ownerAliases', []);
  });

  teardown(async () => {
    sandbox.restore();
    await closeAllEditors();
    await setGlobalSetting('projectManager.todo', 'enabled', undefined);
    await setGlobalSetting('projectManager.todo', 'tags', undefined);
    await setGlobalSetting('projectManager.todo', 'markdownTasks', undefined);
    await setGlobalSetting('projectManager.todo', 'highlight', undefined);
    await setGlobalSetting('projectManager.todo', 'owner', undefined);
    await setGlobalSetting('projectManager.todo', 'ownerAliases', undefined);
  });

  test('INT-196 注册 TODO 视图、命令和配置分组', async () => {
    const api = await getApi();
    const extension = vscode.extensions.getExtension('local-development.project-butler');
    assert.ok(extension);
    const views = extension.packageJSON.contributes?.views as Record<string, Array<{ id?: string; visibility?: string }>>;
    const todoInExplorer = views.explorer?.filter((view) => view.id === 'projectManager.todoView') ?? [];
    const todoInPluginContainer = views.projectManager?.filter((view) => view.id === 'projectManager.todoView') ?? [];
    assert.deepEqual(todoInExplorer, [{
      id: 'projectManager.todoView',
      name: '代码 TODO',
      contextualTitle: '代码浏览',
      visibility: 'collapsed',
    }]);
    assert.equal(todoInPluginContainer.length, 0);
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'projectManager.todo.refresh', 'projectManager.todo.quickMark',
      'projectManager.todo.repeatLastMark', 'projectManager.todo.manageTags',
      'projectManager.todo.configureOwner', 'projectManager.todo.assignToMe',
      'projectManager.todo.unassignMine', 'projectManager.todo.clearFilter',
      'projectManager.configureCatalogTodoSetting',
    ]) assert.ok(commands.includes(command), `缺少命令 ${command}`);
    const groups = api.catalogs.configurationProvider.getChildren()
      .filter((node): node is Extract<ConfigurationTreeNode, { kind: 'group' }> => node.kind === 'group');
    assert.ok(groups.some((group) => group.id === 'todo'));
    assert.equal(api.todo.isScanning(), false);
  });

  test('INT-197 当前文件扫描识别 TODO/FIXME 且不误匹配 DEBUG 标识符', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/workspace-one/src/todo-sample.ts');
    await openText(uri);
    api.todo.provider.scope = 'currentFile';
    const summary = await api.todo.refresh();
    const entry = api.todo.index.get(uri.toString());
    assert.equal(summary.results, 2);
    assert.deepEqual(entry?.matches.map((match) => match.tag), ['TODO', 'FIXME']);
  });

  test('INT-198 启用 DEBUG 后只增加真实注释标记', async () => {
    const api = await getApi();
    const document = await vscode.workspace.openTextDocument({
      language: 'typescript',
      content: '// DEBUG: inspect this\nconst DEBUG_MODE = true;\nconsole.log("DEBUG");',
    });
    await vscode.window.showTextDocument(document);
    await setGlobalSetting('projectManager.todo', 'tags', ['TODO', 'DEBUG']);
    api.todo.provider.scope = 'currentFile';
    await api.todo.refresh();
    assert.deepEqual(api.todo.index.get(document.uri.toString())?.matches.map((match) => match.tag), ['DEBUG']);
  });

  test('INT-199 TODO 树支持按标签分组和筛选', async () => {
    const api = await getApi();
    await openText(projectUri(api, 'test-fixtures/workspace-one/src/todo-sample.ts'));
    api.todo.provider.scope = 'currentFile';
    await api.todo.refresh();
    api.todo.provider.grouping = 'tag';
    api.todo.provider.filter = 'placeholder';
    const nodes = flattenTodoNodes(api.todo.provider);
    assert.ok(nodes.some((node) => node.kind === 'tag' && node.tag === 'FIXME'));
    assert.ok(!nodes.some((node) => node.kind === 'tag' && node.tag === 'TODO'));
  });

  test('INT-200 快速标记和重复上次类型编辑当前文档', async () => {
    const api = await getApi();
    const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = 1;\n' });
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    stubQuickPick(sandbox, ['FIXME']);
    assert.equal(await api.todo.marker.quickMark(false), true);
    assert.match(document.getText(), /^\/\/ FIXME\(scnable-test\):/);
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    assert.equal(await api.todo.marker.quickMark(true), true);
    assert.equal(document.getText().match(/\/\/ FIXME\(scnable-test\):/g)?.length, 2);
  });

  test('INT-201 工作区扫描建立目录层级且不重复磁盘与打开文档', async () => {
    const api = await getApi();
    const uri = vscode.Uri.joinPath(currentWorkspaceUri(), 'src', 'todo-sample.ts');
    await openText(uri);
    api.todo.provider.scope = 'workspace';
    api.todo.provider.grouping = 'file';
    const summary = await api.todo.refresh();
    const nodes = flattenTodoNodes(api.todo.provider);
    assert.ok(summary.results >= 2);
    assert.equal(api.todo.index.values().filter((entry) => entry.uri === uri.toString()).length, 1);
    assert.ok(nodes.some((node) => node.kind === 'directory' && node.path === 'src'));
    assert.ok(nodes.some((node) => node.kind === 'file' && node.resource.uri === uri.toString()));
  });

  test('INT-202 树节点编辑先定位目标并只修改该标记', async () => {
    const api = await getApi();
    const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: '// TODO: keep this text\n' });
    await vscode.window.showTextDocument(document);
    api.todo.provider.scope = 'currentFile';
    api.todo.provider.grouping = 'file';
    api.todo.provider.filter = '';
    await api.todo.refresh();
    const result = flattenTodoNodes(api.todo.provider).find((node) => node.kind === 'result');
    assert.ok(result);
    assert.equal(await vscode.commands.executeCommand<boolean>('projectManager.todo.toggleCompleted', result), true);
    assert.equal(document.getText(), '// TODO [x]: keep this text\n');
    assert.equal(await vscode.commands.executeCommand<boolean>('projectManager.todo.removeMark', result), true);
    assert.equal(document.getText(), '// keep this text\n');
  });

  test('INT-203 当前文件范围切换编辑器后不残留旧文件', async () => {
    const api = await getApi();
    await vscode.commands.executeCommand('projectManager.todoView.focus');
    api.todo.provider.scope = 'currentFile';
    api.todo.provider.filter = '';
    const first = await vscode.workspace.openTextDocument({ language: 'typescript', content: '// TODO: first\n' });
    await vscode.window.showTextDocument(first);
    await api.todo.refresh();
    const second = await vscode.workspace.openTextDocument({ language: 'typescript', content: '// FIXME: second\n' });
    await vscode.window.showTextDocument(second);
    await delay(350);
    assert.equal(api.todo.index.size, 1);
    assert.equal(api.todo.index.get(first.uri.toString()), undefined);
    assert.deepEqual(api.todo.index.get(second.uri.toString())?.matches.map((match) => match.tag), ['FIXME']);
  });

  test('INT-204 工作区范围使用未保存文档增量覆盖扫描结果', async () => {
    const api = await getApi();
    await vscode.commands.executeCommand('projectManager.todoView.focus');
    const uri = vscode.Uri.joinPath(currentWorkspaceUri(), 'src', 'todo-sample.ts');
    const editor = await openText(uri);
    api.todo.provider.scope = 'workspace';
    api.todo.provider.filter = '';
    await api.todo.refresh();
    const source = editor.document.getText();
    const start = source.indexOf('TODO');
    assert.ok(start >= 0);
    await editor.edit((edit) => edit.replace(new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(start + 4)), 'BUG'));
    await waitUntil(
      () => api.todo.index.get(uri.toString())?.matches.some((match) => match.tag === 'BUG') === true,
      '未保存文档的 BUG 标记未进入工作区索引',
    );
    assert.equal(api.todo.index.get(uri.toString())?.matches.some((match) => match.tag === 'TODO'), false);
  });

  test('INT-205 工作区扫描先筛选可解析源码且不再报告文件数量截断', async () => {
    const api = await getApi();
    api.todo.provider.scope = 'workspace';
    api.todo.provider.filter = '';
    const summary = await api.todo.refresh();
    assert.equal(summary.truncated, false);
    assert.equal(summary.limit, undefined);
    assert.ok(summary.candidateFiles >= summary.files);
    assert.equal(summary.files + summary.skippedFiles, summary.candidateFiles);
    assert.ok(api.todo.index.values().every((entry) => !entry.relativePath.endsWith('.json')));
  });

  test('INT-206 工作区扫描合并 files.exclude 并排除对应源码', async () => {
    const api = await getApi();
    const configuration = vscode.workspace.getConfiguration('files');
    const original = configuration.inspect<Record<string, unknown>>('exclude')?.workspaceValue;
    const uri = vscode.Uri.joinPath(currentWorkspaceUri(), 'src', 'todo-sample.ts');
    try {
      await setWorkspaceSetting('files', 'exclude', { ...(original ?? {}), 'src/todo-sample.ts': true });
      api.todo.provider.scope = 'workspace';
      const summary = await api.todo.refresh();
      assert.equal(summary.truncated, false);
      assert.equal(api.todo.index.get(uri.toString()), undefined);
    } finally {
      await setWorkspaceSetting('files', 'exclude', original);
    }
  });

  test('INT-207 本地 Git 工作区使用快速候选搜索并保留未跟踪源码', async () => {
    const api = await getApi();
    const uri = vscode.Uri.joinPath(currentWorkspaceUri(), 'src', 'todo-sample.ts');
    api.todo.provider.scope = 'workspace';
    const summary = await api.todo.refresh();
    assert.equal(summary.backend, 'git');
    assert.ok(summary.discoveredFiles >= summary.candidateFiles);
    assert.ok(api.todo.index.get(uri.toString())?.matches.length === 2, 'Git 快速路径遗漏未跟踪 TODO 源码');
  });

  test('INT-208 完整扫描只绘制开始、打开文件首屏和最终结果', async () => {
    const api = await getApi();
    await openText(vscode.Uri.joinPath(currentWorkspaceUri(), 'src', 'todo-sample.ts'));
    api.todo.provider.scope = 'workspace';
    const before = api.todo.getTreeRefreshCount();
    const summary = await api.todo.refresh();
    const refreshes = api.todo.getTreeRefreshCount() - before;
    assert.ok(refreshes >= 2 && refreshes <= 3, `完整扫描触发了 ${refreshes} 次树绘制`);
    assert.equal(api.todo.getLastSummary(), summary);
    assert.match(api.todo.view.message ?? '', /扫描完成（Git 快速搜索）/);
    assert.ok(api.todo.index.values().every((entry) => entry.matches.length > 0), '零结果文件进入了可绘制索引');
  });

  test('INT-209 快速后端不可用时安全回退 VS Code API', async () => {
    const api = await getApi();
    const scanner = new TodoScanner(new TodoIndex(), api.output, { search: async () => undefined });
    const source = new vscode.CancellationTokenSource();
    try {
      const summary = await scanner.scanWorkspace(source.token);
      assert.equal(summary.backend, 'vscode');
      assert.equal(summary.files + summary.skippedFiles, summary.candidateFiles);
      assert.ok(summary.results >= 2);
    } finally {
      source.dispose();
    }
  });

  test('INT-210 个人标记优先分组且其他源码标记保持可见', async () => {
    const api = await getApi();
    const document = await vscode.workspace.openTextDocument({
      language: 'typescript',
      content: '// TODO(scnable-test): mine\n// FIXME: shared\n',
    });
    await vscode.window.showTextDocument(document);
    api.todo.provider.scope = 'currentFile';
    api.todo.provider.grouping = 'file';
    api.todo.provider.filter = '';
    await api.todo.refresh();
    const roots = api.todo.provider.getChildren();
    assert.deepEqual(roots.map((node) => node.kind === 'ownerGroup' ? node.ownership : node.kind), ['mine', 'other']);
    const nodes = flattenTodoNodes(api.todo.provider);
    const results = nodes.filter((node) => node.kind === 'result');
    assert.equal(results.length, 2);
    assert.ok(results.some((node) => node.kind === 'result' && node.match.owner === 'scnable-test'));
    assert.ok(results.some((node) => node.kind === 'result' && node.match.owner === undefined));
  });

  test('INT-211 目录链压缩且已有标记可以认领和取消归属', async () => {
    const api = await getApi();
    const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: '// TODO: shared\n' });
    await vscode.window.showTextDocument(document);
    api.todo.provider.scope = 'currentFile';
    api.todo.provider.grouping = 'file';
    api.todo.provider.filter = '';
    await api.todo.refresh();
    let result = flattenTodoNodes(api.todo.provider).find((node) => node.kind === 'result');
    assert.ok(result);
    assert.equal(await vscode.commands.executeCommand<boolean>('projectManager.todo.assignToMe', result), true);
    assert.equal(document.getText(), '// TODO(scnable-test): shared\n');
    await api.todo.refresh();
    result = flattenTodoNodes(api.todo.provider).find((node) => node.kind === 'result');
    assert.ok(result);
    assert.equal(await vscode.commands.executeCommand<boolean>('projectManager.todo.unassignMine', result), true);
    assert.equal(document.getText(), '// TODO: shared\n');

    api.todo.index.clear();
    const match = {
      tag: 'TODO', rawTag: 'TODO', owner: 'scnable-test', text: 'sample', line: 0,
      startCharacter: 3, endCharacter: 7, completed: false, source: 'comment' as const,
    };
    const workspaceUri = currentWorkspaceUri().toString();
    api.todo.index.replace('file:///account.ts', [match], 100, 'src/pages/user/profile/settings/AccountSettings.ts', workspaceUri);
    api.todo.index.replace('file:///overview.ts', [match], 100, 'src/pages/admin/dashboard/Overview.ts', workspaceUri);
    const mine = api.todo.provider.getChildren().find((node) => node.kind === 'ownerGroup' && node.ownership === 'mine');
    assert.ok(mine);
    const directory = api.todo.provider.getChildren(mine)[0];
    assert.ok(directory?.kind === 'directory');
    assert.equal(directory.label, 'src/pages/');
  });

  test('INT-214 修改集合关键词后可见 TODO 视图立即使用新配置重扫', async () => {
    const api = await getApi();
    const catalog = createCatalogForWorkspace('TODO 实时配置', { todo: { tags: ['FIXME'] } });
    await seedCatalogs(api, [catalog], catalog.id);
    const uri = projectUri(api, 'test-fixtures/workspace-one/src/todo-sample.ts');
    await openText(uri);
    api.todo.provider.scope = 'currentFile';
    await api.todo.refresh();
    assert.deepEqual(api.todo.index.get(uri.toString())?.matches.map((match) => match.tag), ['FIXME']);

    await api.catalogs.service.updateCurrentTodoTags(['TODO'], false);
    await waitUntil(
      () => api.todo.index.get(uri.toString())?.matches.map((match) => match.tag).join(',') === 'TODO',
      '集合关键词变更后 TODO 视图没有立即重扫',
    );
    await resetCatalogs(api);
  });

  test('INT-215 工作区扫描失败时恢复旧快照并只暴露安全错误类别', async () => {
    const api = await getApi();
    const index = new TodoIndex();
    index.replace('file:///retained.ts', [{
      tag: 'TODO', rawTag: 'TODO', text: 'retained', line: 0,
      startCharacter: 3, endCharacter: 7, completed: false, source: 'comment',
    }], 1, 'src/retained.ts', currentWorkspaceUri().toString());
    const scanner = new TodoScanner(index, api.output, { search: async () => { throw new TypeError('private path'); } });
    const source = new vscode.CancellationTokenSource();
    try {
      const summary = await scanner.scanWorkspace(source.token);
      assert.equal(summary.phase, 'failed');
      assert.equal(summary.error, 'TypeError');
      assert.equal(summary.stale, true);
      assert.equal(summary.results, 1);
      assert.equal(index.get('file:///retained.ts')?.matches[0]?.text, 'retained');
    } finally {
      source.dispose();
    }
  });

  test('INT-216 当前范围无结果时显示范围和有效关键词', async () => {
    const api = await getApi();
    const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const clean = true;\n' });
    await vscode.window.showTextDocument(document);
    api.todo.provider.scope = 'currentFile';
    api.todo.provider.filter = '';
    await api.todo.refresh();
    assert.match(api.todo.view.message ?? '', /没有找到标记。范围：当前文件；当前关键词：TODO、FIXME、BUG、HACK、XXX/);
  });

  test('INT-217 筛选无结果时明确原因且可一键清除恢复结果', async () => {
    const api = await getApi();
    const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: '// TODO: visible\n' });
    await vscode.window.showTextDocument(document);
    api.todo.provider.scope = 'currentFile';
    api.todo.provider.filter = '';
    await api.todo.refresh();

    stubInputBox(sandbox, ['does-not-exist']);
    await vscode.commands.executeCommand('projectManager.todo.filter');
    assert.match(api.todo.view.message ?? '', /筛选“does-not-exist”没有匹配结果/);
    assert.equal(api.todo.provider.visibleResultCount, 0);

    await vscode.commands.executeCommand('projectManager.todo.clearFilter');
    assert.equal(api.todo.provider.filter, '');
    assert.equal(api.todo.provider.visibleResultCount, 1);
    assert.doesNotMatch(api.todo.view.message ?? '', /没有匹配结果/);
  });

  test('INT-218 非 file URI 当前文件通过 VS Code 文档接口完成扫描', async () => {
    const api = await getApi();
    const cancellation = new vscode.CancellationTokenSource();
    const remoteFolder: vscode.WorkspaceFolder = {
      uri: vscode.Uri.parse('vscode-remote://ssh-remote+test/workspace'),
      name: 'remote-workspace',
      index: 0,
    };
    assert.equal(await new LocalTodoCandidateSearch().search(remoteFolder, ['TODO'], [], cancellation.token), undefined);
    cancellation.dispose();
    const scheme = 'todo-remote-test';
    const content = new TextEncoder().encode('// TODO: remote source\n');
    const events = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    const provider: vscode.FileSystemProvider = {
      onDidChangeFile: events.event,
      watch: () => new vscode.Disposable(() => {}),
      stat: async () => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: content.byteLength }),
      readDirectory: async () => [],
      createDirectory: async () => { throw vscode.FileSystemError.NoPermissions(); },
      readFile: async () => content,
      writeFile: async () => { throw vscode.FileSystemError.NoPermissions(); },
      delete: async () => { throw vscode.FileSystemError.NoPermissions(); },
      rename: async () => { throw vscode.FileSystemError.NoPermissions(); },
    };
    const registration = vscode.workspace.registerFileSystemProvider(scheme, provider, { isCaseSensitive: true, isReadonly: true });
    try {
      const uri = vscode.Uri.parse(`${scheme}://host/workspace/src/remote.ts`);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      api.todo.provider.scope = 'currentFile';
      api.todo.provider.filter = '';
      const summary = await api.todo.refresh();
      assert.equal(summary.backend, 'currentFile');
      assert.equal(summary.results, 1);
      assert.equal(api.todo.index.get(uri.toString())?.matches[0]?.text, 'remote source');
    } finally {
      registration.dispose();
      events.dispose();
    }
  });
});
