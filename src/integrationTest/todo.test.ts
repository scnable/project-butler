import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { ConfigurationTreeNode } from '../configuration/configurationTreeProvider';
import { TodoIndex } from '../todo/todoIndex';
import { LocalTodoCandidateSearch } from '../todo/todoLocalSearch';
import { TodoScanner } from '../todo/todoScanner';
import { TODO_CACHE_KEY } from '../todo/todoPersistentCache';
import { todoCacheSignature } from '../todo/todoCacheInventory';
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
    await setGlobalSetting('projectManager.todo', 'showProjectMarkers', true);
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
    await setGlobalSetting('projectManager.todo', 'showProjectMarkers', undefined);
  });

  test('INT-196 注册 TODO 视图、命令和配置分组', async () => {
    const api = await getApi();
    await api.todo.waitForIdleForIntegrationTest();
    const extension = vscode.extensions.getExtension('scnable.catlas-hub');
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
    assert.equal(extension.packageJSON.contributes?.configuration?.properties?.['projectManager.todo.showProjectMarkers']?.default, false);
    const quickMarkCommand = extension.packageJSON.contributes?.commands?.find(
      (command: { command?: string }) => command.command === 'projectManager.todo.quickMark',
    );
    assert.equal(quickMarkCommand?.icon, '$(add)');
    const viewTitleMenus = extension.packageJSON.contributes?.menus?.['view/title'] as Array<{ command?: string; when?: string }>;
    assert.ok(viewTitleMenus.some((menu) => menu.command === 'projectManager.todo.quickMark'
      && menu.when === 'view == projectManager.todoView'));
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
    api.todo.provider.scope = 'currentFile';
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const tags = ['FIXME', 'BUG', 'TODO'];
    let tagChoice = 0;
    const chooseTagOrDescription = (items: readonly unknown[]): unknown => {
      if (typeof items[0] === 'string') return tags[tagChoice++];
      if (tagChoice < 3) return items[0];
      return items.find((item: unknown) => typeof item === 'object' && item !== null && 'label' in item
        && (item as { label: string }).label === '优化重复标记');
    };
    stubQuickPick(sandbox, Array.from({ length: 6 }, () => chooseTagOrDescription));
    stubInputBox(sandbox, ['添加数值初始化', '优化重复标记', '修改数值初始化问题']);
    assert.equal(await vscode.commands.executeCommand<boolean>('projectManager.todo.quickMark'), true);
    assert.match(document.getText(), /^\/\/ FIXME\(scnable-test\): 添加数值初始化/);
    assert.equal(api.todo.index.get(document.uri.toString())?.matches[0]?.tag, 'FIXME');
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    assert.equal(await vscode.commands.executeCommand<boolean>('projectManager.todo.repeatLastMark'), true);
    assert.equal(document.getText().match(/\/\/ FIXME\(scnable-test\):/g)?.length, 2);
    assert.equal(api.todo.index.get(document.uri.toString())?.matches.length, 2);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    assert.equal(await vscode.commands.executeCommand<boolean>('projectManager.todo.quickMark'), true);
    assert.match(document.getText(), /^\/\/ BUG\(scnable-test\): 修改数值初始化问题/);
    assert.equal(api.todo.index.get(document.uri.toString())?.matches[0]?.text, '修改数值初始化问题');
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    assert.equal(await vscode.commands.executeCommand<boolean>('projectManager.todo.quickMark'), true);
    assert.match(document.getText(), /\/\/ TODO\(scnable-test\): 优化重复标记\r?\nconst value/);
    assert.equal(api.todo.index.get(document.uri.toString())?.matches.length, 3);
  });

  test('INT-201 工作区扫描按完整任务描述分组且不重复磁盘与打开文档', async () => {
    const api = await getApi();
    const uri = vscode.Uri.joinPath(currentWorkspaceUri(), 'src', 'todo-sample.ts');
    await openText(uri);
    api.todo.provider.scope = 'workspace';
    api.todo.provider.grouping = 'category';
    api.todo.provider.filter = '';
    const summary = await api.todo.refresh();
    const nodes = flattenTodoNodes(api.todo.provider);
    assert.ok(summary.results >= 2);
    assert.equal(api.todo.index.values().filter((entry) => entry.uri === uri.toString()).length, 1);
    assert.ok(nodes.some((node) => node.kind === 'result' && node.resource.uri === uri.toString()));
    const ownerGroups = api.todo.provider.getChildren().filter((node) => node.kind === 'ownerGroup');
    const descriptionGroups = ownerGroups.flatMap((owner) => api.todo.provider.getChildren(owner));
    assert.ok(descriptionGroups.length > 0);
    assert.ok(descriptionGroups.every((node) => node.kind === 'category'));
    assert.ok(descriptionGroups.some((node) => node.kind === 'category'
      && node.descriptionKey === 'complete the sample workflow'));
    assert.ok(descriptionGroups.some((node) => node.kind === 'category'
      && node.descriptionKey === 'replace the placeholder implementation'));
    assert.ok(!descriptionGroups.some((node) => node.kind === 'category' && node.label === '其他任务'));
    assert.ok(descriptionGroups.every((node) => api.todo.provider.getTreeItem(node).collapsibleState === vscode.TreeItemCollapsibleState.Expanded));
    assert.ok(descriptionGroups.every((node) => api.todo.provider.getTreeItem(node).id?.startsWith('projectManager.todo.description.')));
    const firstDescription = descriptionGroups.find((node) => node.kind === 'category');
    assert.ok(firstDescription);
    const groupedResult = api.todo.provider.getChildren(firstDescription).find((node) => node.kind === 'result');
    assert.ok(groupedResult);
    assert.match(String(api.todo.provider.getTreeItem(groupedResult).label), /\.ts:\d+$/);
    assert.ok(nodes.every((node) => node.kind !== 'result' || node.resource.relativePath.length > 0));
  });

  test('INT-202 树节点编辑先定位目标并只修改该标记', async () => {
    const api = await getApi();
    const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: '// TODO: keep this text\n' });
    await vscode.window.showTextDocument(document);
    api.todo.provider.scope = 'currentFile';
    api.todo.provider.grouping = 'category';
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
    await closeAllEditors();
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
    await delay(220);
    await api.todo.waitForIdleForIntegrationTest();
    api.todo.provider.scope = 'workspace';
    const before = api.todo.getTreeRefreshCount();
    const summary = await api.todo.refresh();
    const refreshes = api.todo.getTreeRefreshCount() - before;
    assert.ok(refreshes >= 2 && refreshes <= 3, `完整扫描触发了 ${refreshes} 次树绘制`);
    assert.equal(api.todo.getLastSummary(), summary);
    assert.match(api.todo.view.message ?? '', /条标记 · (刚刚更新|上次完整更新)/);
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

  test('INT-210 默认个人模式隐藏项目已有标记，开启后才恢复显示', async () => {
    const api = await getApi();
    await setGlobalSetting('projectManager.todo', 'showProjectMarkers', false);
    const document = await vscode.workspace.openTextDocument({
      language: 'typescript',
      content: '// TODO(scnable-test): mine\n// FIXME: shared\n',
    });
    await vscode.window.showTextDocument(document);
    api.todo.provider.scope = 'currentFile';
    api.todo.provider.grouping = 'category';
    api.todo.provider.filter = '';
    await api.todo.refresh();
    const roots = api.todo.provider.getChildren();
    assert.deepEqual(roots.map((node) => node.kind === 'ownerGroup' ? node.ownership : node.kind), ['mine']);
    const nodes = flattenTodoNodes(api.todo.provider);
    const results = nodes.filter((node) => node.kind === 'result');
    assert.equal(results.length, 1);
    assert.ok(results.some((node) => node.kind === 'result' && node.match.owner === 'scnable-test'));
    assert.ok(!results.some((node) => node.kind === 'result' && node.match.owner === undefined));

    await setGlobalSetting('projectManager.todo', 'showProjectMarkers', true);
    await api.todo.refresh();
    const expanded = flattenTodoNodes(api.todo.provider).filter((node) => node.kind === 'result');
    assert.equal(expanded.length, 2);
    assert.ok(expanded.some((node) => node.kind === 'result' && node.match.owner === undefined));
  });

  test('INT-226 未设置个人标识且项目标记关闭时不启动候选文件搜索', async () => {
    const api = await getApi();
    await setGlobalSetting('projectManager.todo', 'owner', '');
    await setGlobalSetting('projectManager.todo', 'showProjectMarkers', false);
    let searches = 0;
    const scanner = new TodoScanner(new TodoIndex(), api.output, {
      async search() {
        searches += 1;
        return undefined;
      },
    });
    const source = new vscode.CancellationTokenSource();
    try {
      const summary = await scanner.scanWorkspace(source.token);
      assert.equal(searches, 0);
      assert.equal(summary.candidateFiles, 0);
      assert.equal(summary.results, 0);
    } finally {
      source.dispose();
    }
  });

  test('INT-211 同描述保持独立来源且已有标记可以认领和取消归属', async () => {
    const api = await getApi();
    const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: '// TODO: shared\n' });
    await vscode.window.showTextDocument(document);
    api.todo.provider.scope = 'currentFile';
    api.todo.provider.grouping = 'category';
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
    const taskNodes = flattenTodoNodes(api.todo.provider).filter((node) => node.kind === 'result'
      && (node.resource.uri === 'file:///account.ts' || node.resource.uri === 'file:///overview.ts'));
    assert.equal(taskNodes.length, 2);
    assert.deepEqual(taskNodes.map((node) => node.kind === 'result' ? node.resource.relativePath : ''), [
      'src/pages/user/profile/settings/AccountSettings.ts',
      'src/pages/admin/dashboard/Overview.ts',
    ].sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true })));
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
      assert.ok(summary.results >= 1);
      assert.equal(index.get('file:///retained.ts')?.matches[0]?.text, 'retained');
    } finally {
      source.dispose();
    }
  });

  test('INT-216 当前范围无结果时使用精简明确文案', async () => {
    const api = await getApi();
    const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const clean = true;\n' });
    await vscode.window.showTextDocument(document);
    api.todo.provider.scope = 'currentFile';
    api.todo.provider.filter = '';
    await api.todo.refresh();
    assert.match(api.todo.view.message ?? '', /未发现标记/);
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
    assert.equal(await new LocalTodoCandidateSearch().search(
      remoteFolder, { mode: 'fixed', patterns: ['TODO'] }, [], cancellation.token,
    ), undefined);
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

  test('INT-230 未打开的非 UTF-8 源文件仍能进入个人标记索引', async () => {
    const api = await getApi();
    const scheme = 'todo-gbk-test';
    const prefix = new TextEncoder().encode('// TODO(scnable-test): ');
    const gbkDescription = Uint8Array.from([0xb2, 0xe2, 0xca, 0xd4, 0xb1, 0xe0, 0xc2, 0xeb, 0x0a]);
    const content = new Uint8Array(prefix.byteLength + gbkDescription.byteLength);
    content.set(prefix, 0);
    content.set(gbkDescription, prefix.byteLength);
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
    const scanner = new TodoScanner(new TodoIndex(), api.output);
    const uri = vscode.Uri.parse(`${scheme}://host/workspace/src/legacy.c`);
    try {
      assert.equal(await scanner.scanUri(uri), true);
      const matches = scanner.index.get(uri.toString())?.matches ?? [];
      assert.equal(matches.length, 1);
      assert.equal(matches[0]?.tag, 'TODO');
      assert.equal(matches[0]?.owner, 'scnable-test');
    } finally {
      registration.dispose();
      events.dispose();
    }
  });

  test('INT-228 打开的排除文件在完整更新结束后仍保留实时个人标记', async () => {
    const api = await getApi();
    const configuration = vscode.workspace.getConfiguration('files');
    const original = configuration.inspect<Record<string, unknown>>('exclude')?.workspaceValue;
    const uri = vscode.Uri.joinPath(currentWorkspaceUri(), 'src', 'todo-sample.ts');
    try {
      await setGlobalSetting('projectManager.todo', 'showProjectMarkers', false);
      await setWorkspaceSetting('files', 'exclude', { ...(original ?? {}), 'src/todo-sample.ts': true });
      const editor = await openText(uri);
      const insertion = new vscode.Position(editor.document.lineCount - 1, 0);
      await editor.edit((edit) => edit.insert(insertion, '// TODO(scnable-test): unsaved live marker\n'));
      api.todo.provider.scope = 'workspace';
      const summary = await api.todo.refresh();

      assert.equal(summary.cancelled, false);
      assert.ok(api.todo.index.get(uri.toString())?.matches.some((match) => match.text === 'unsaved live marker'));
    } finally {
      await closeAllEditors();
      await setWorkspaceSetting('files', 'exclude', original);
    }
  });

  test('INT-231 持久缓存重启后复用未变文件并发现新增与删除', async () => {
    const api = await getApi();
    await setGlobalSetting('projectManager.todo', 'showProjectMarkers', false);
    await api.todo.waitForIdleForIntegrationTest();
    await closeAllEditors();
    const root = currentWorkspaceUri();
    const a = vscode.Uri.joinPath(root, 'cache-fixture-a.ts');
    const b = vscode.Uri.joinPath(root, 'cache-fixture-b.ts');
    const c = vscode.Uri.joinPath(root, 'cache-fixture-c.ts');
    const texts = new Map([[a.toString(), '// TODO(scnable-test): first'], [b.toString(), '// TODO(other): foreign']]);
    const stamps = new Map([...texts.keys()].map((key) => [key, 1]));
    sandbox.stub(vscode.workspace, 'findFiles').callsFake(async () => [...texts.keys()].map((key) => vscode.Uri.parse(key)));
    const fileAccess = {
      stat: async (uri: vscode.Uri) => ({ type: vscode.FileType.File,
        mtime: stamps.get(uri.toString()) ?? 1, ctime: stamps.get(uri.toString()) ?? 1, size: texts.get(uri.toString())?.length ?? 0 }),
      readFile: async (uri: vscode.Uri): Promise<Uint8Array> => Buffer.from(texts.get(uri.toString()) ?? ''),
    };
    const read = sandbox.stub(fileAccess, 'readFile').callsFake(async (uri) => Buffer.from(texts.get(uri.toString()) ?? ''));
    let saved: unknown;
    const storage = { get: () => saved, update: async (_key: string, value: unknown) => { saved = value; } } as unknown as vscode.Memento;
    const search = { search: async () => ({ backend: 'git' as const, relativePaths: ['cache-fixture-a.ts'] }) };
    const first = new TodoScanner(new TodoIndex(), api.output, search, storage, fileAccess);
    const token = new vscode.CancellationTokenSource();
    try {
      await first.scanWorkspace(token.token);
      assert.equal(typeof saved, 'string');
      assert.equal(String(saved).includes('foreign'), false, '默认个人范围不能缓存其他人的标记描述');
      const second = new TodoScanner(new TodoIndex(), api.output, search, storage, fileAccess);
      assert.equal(second.restoreCache(), true);
      read.resetHistory();
      const warm = await second.updateWorkspace(token.token);
      assert.equal(warm.updateKind, 'incremental');
      assert.equal(read.callCount, 0);
      assert.equal(warm.reusedFiles, 2);
      texts.delete(a.toString());
      texts.set(b.toString(), '// TODO(scnable-test): changed empty file');
      stamps.set(b.toString(), 2);
      texts.set(c.toString(), '// TODO(scnable-test): new file');
      const changed = await second.updateWorkspace(token.token);
      assert.equal(changed.stale, false);
      assert.equal(second.index.get(a.toString()), undefined);
      assert.equal(second.index.get(b.toString())?.matches[0]?.text, 'changed empty file');
      assert.equal(second.index.get(c.toString())?.matches[0]?.text, 'new file');
      const beforeFailure = saved;
      stamps.set(c.toString(), 9);
      read.rejects(new Error('模拟读取失败'));
      assert.equal((await second.updateWorkspace(token.token)).phase, 'failed');
      assert.equal(saved, beforeFailure);
      assert.equal(second.index.size, 2);
      const beforeCancel = saved;
      token.cancel();
      assert.equal((await second.updateWorkspace(token.token)).cancelled, true);
      assert.equal(saved, beforeCancel);
      assert.equal(second.index.size, 2);
    } finally { token.dispose(); }
  });

  test('INT-233 超大文件默认跳过但不阻断缓存，缩小后恢复扫描', async () => {
    const api = await getApi();
    await setGlobalSetting('projectManager.todo', 'showProjectMarkers', false);
    await api.todo.waitForIdleForIntegrationTest();
    await closeAllEditors();
    const uri = vscode.Uri.joinPath(currentWorkspaceUri(), 'size-policy-fixture.ts');
    const limit = 2 * 1024 * 1024;
    let size = limit + 1;
    let stamp = 1;
    sandbox.stub(vscode.workspace, 'findFiles').resolves([uri]);
    const readFile = sandbox.stub().callsFake(async () => {
      assert.ok(size <= limit, '超大文件不得读取正文');
      return Buffer.from('// TODO(scnable-test): boundary\n'.padEnd(size, ' '));
    });
    const access = { stat: async () => ({ type: vscode.FileType.File, mtime: stamp, ctime: stamp, size }), readFile };
    let saved: unknown;
    const storage = { get: () => saved, update: async (_key: string, value: unknown) => { saved = value; } } as unknown as vscode.Memento;
    const search = { search: async () => ({ backend: 'git' as const, relativePaths: ['size-policy-fixture.ts'] }) };
    const token = new vscode.CancellationTokenSource();
    try {
      const first = new TodoScanner(new TodoIndex(), api.output, search, storage, access);
      const full = await first.scanWorkspace(token.token);
      assert.equal(full.phase, 'complete');
      assert.equal(full.oversizedFiles, 1);
      assert.equal(full.files, 0);
      assert.equal(full.skippedFiles, 1);
      assert.equal(readFile.callCount, 0);
      assert.equal(typeof saved, 'string', '按大小跳过不能阻断正常缓存');
      const second = new TodoScanner(new TodoIndex(), api.output, search, storage, access);
      assert.equal(second.restoreCache(), true);
      const warm = await second.updateWorkspace(token.token);
      assert.equal(warm.updateKind, 'incremental');
      assert.equal(warm.stale, false);
      assert.equal(warm.oversizedFiles, 1);
      assert.equal(readFile.callCount, 0);
      size = limit; stamp += 1;
      const shrunk = await second.updateWorkspace(token.token);
      assert.equal(shrunk.stale, false);
      assert.equal(shrunk.oversizedFiles, 0);
      assert.equal(readFile.callCount, 1, '恰好 2 MiB 应正常读取');
      assert.equal(second.index.get(uri.toString())?.matches[0]?.text, 'boundary');
      size = limit + 1; stamp += 1;
      const grown = await second.updateWorkspace(token.token);
      assert.equal(grown.stale, false);
      assert.equal(grown.oversizedFiles, 1);
      assert.equal(readFile.callCount, 1);
      assert.equal(second.index.get(uri.toString()), undefined, '变大后不能残留旧磁盘标记');
    } finally { token.dispose(); }
  });

  test('INT-232 缓存恢复不覆盖当前编辑，损坏或越界缓存被拒绝', async () => {
    const api = await getApi();
    await api.todo.waitForIdleForIntegrationTest();
    let raw = '{broken';
    const scanner = new TodoScanner(new TodoIndex(), api.output, undefined,
      { get: () => raw, update: async () => undefined } as unknown as vscode.Memento);
    assert.equal(scanner.restoreCache(), false);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(currentWorkspaceUri(), 'src', 'todo-sample.ts'));
    scanner.scanDocument(document);
    const before = scanner.index.snapshot();
    const now = Date.now();
    raw = JSON.stringify({ version: 1, signature: todoCacheSignature(), savedAt: now, fullAt: now,
      files: [{ uri: document.uri.toString(), mtime: 0, ctime: 0, size: 0, matches: [] }] });
    assert.equal(scanner.restoreCache(), true);
    assert.deepEqual(scanner.index.snapshot(), before, '旧缓存不能覆盖本会话已解析文档');
    raw = JSON.stringify({ version: 1, signature: todoCacheSignature(), savedAt: now, fullAt: now,
      files: [{ uri: 'file:///outside-workspace/todo.ts', mtime: 0, ctime: 0, size: 0, matches: [] }] });
    assert.equal(scanner.restoreCache(), false);
    assert.deepEqual(scanner.index.snapshot(), before);
    assert.equal(TODO_CACHE_KEY.startsWith('projectManager.todo.'), true);
  });

  test('INT-229 关闭排除文件后后台更新将其从个人标记集合移除', async () => {
    const api = await getApi();
    const configuration = vscode.workspace.getConfiguration('files');
    const original = configuration.inspect<Record<string, unknown>>('exclude')?.workspaceValue;
    const uri = vscode.Uri.joinPath(currentWorkspaceUri(), 'src', 'todo-sample.ts');
    try {
      await setGlobalSetting('projectManager.todo', 'showProjectMarkers', false);
      await setWorkspaceSetting('files', 'exclude', { ...(original ?? {}), 'src/todo-sample.ts': true });
      const editor = await openText(uri);
      await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '// TODO(scnable-test): close me\n'));
      api.todo.provider.scope = 'workspace';
      api.todo.scanner.scanDocument(editor.document);
      assert.ok(api.todo.index.get(uri.toString()));

      await closeAllEditors();
      await api.todo.waitForIdleForIntegrationTest();
      await waitUntil(() => api.todo.index.get(uri.toString()) === undefined, '关闭的排除文件仍残留在个人标记集合');
    } finally {
      await setWorkspaceSetting('files', 'exclude', original);
    }
  });
});
