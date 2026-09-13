/**
 * TODO 功能的协调入口：共用一个 TodoIndex，连接后台扫描、文档编辑、文件监听、标记命令和视图。
 * 全量刷新通过单个 refreshLoop 串行执行；文件增量更新由 TodoUpdateQueue 合并并限制并发。
 * 历史修复重点：重复全扫曾带来内存压力；快速添加后须立即更新索引，而不能等下一次全量扫描。
 * 磁盘缓存仅在完整校验成功后保存；恢复结果标为待校验，未保存编辑仍以当前文档为准。
 */
import * as vscode from 'vscode';
import { ProjectFeatureConfigurationSource } from '../configuration/configurationTypes';
import { TodoIndex } from './todoIndex';
import { TodoDecorations } from './todoDecorations';
import { formatTodoFreshness } from './todoFreshness';
import { TodoMarker } from './todoMarker';
import { TodoScanner, TodoScanSummary } from './todoScanner';
import { isMyTodoOwner } from './todoOwner';
import { createTodoParseOptionsForPath, getTodoSettings } from './todoSettings';
import { getAllTodoTagChoices, normalizeTodoTagName, normalizeTodoTagNames } from './todoTags';
import { TodoTreeNode, TodoTreeProvider } from './todoTreeProvider';
import { TodoUpdateQueue } from './todoUpdateQueue';
import { TodoViewRefreshPolicy, TodoViewUpdateKind } from './todoViewRefreshPolicy';
import { todoCacheSignature } from './todoCacheInventory';

const LAST_SUCCESSFUL_FULL_UPDATE_KEY = 'projectManager.todo.lastSuccessfulFullUpdateAt';

export interface RegisteredTodo {
  readonly index: TodoIndex;
  readonly scanner: TodoScanner;
  readonly provider: TodoTreeProvider;
  readonly marker: TodoMarker;
  readonly decorations: TodoDecorations;
  readonly view: vscode.TreeView<TodoTreeNode>;
  readonly refresh: (forceFull?: boolean) => Promise<TodoScanSummary>;
  readonly isScanning: () => boolean;
  readonly getLastSummary: () => TodoScanSummary | undefined;
  readonly getTreeRefreshCount: () => number;
  readonly waitForIdleForIntegrationTest: () => Promise<void>;
}

export function registerTodo(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  featureSource: ProjectFeatureConfigurationSource,
  initialization: Promise<void> = Promise.resolve(),
): RegisteredTodo {
  const index = new TodoIndex();
  const scanner = new TodoScanner(index, output, undefined, context.workspaceState);
  const provider = new TodoTreeProvider(index);
  const marker = new TodoMarker(context.workspaceState, () => {
    const identities = getTodoSettings().ownerIdentities;
    return index.values().flatMap((entry) => entry.matches
      .filter((match) => isMyTodoOwner(match.owner, identities))
      .map((match) => match.text));
  });
  const decorations = new TodoDecorations();
  const view = vscode.window.createTreeView('projectManager.todoView', { treeDataProvider: provider, showCollapseAll: true });
  let cancellation: vscode.CancellationTokenSource | undefined;
  const documentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: vscode.FileSystemWatcher | undefined;
  let latestSummary: TodoScanSummary | undefined;
  let hasCompletedScan = false;
  let lastSuccessfulFullUpdateAt = context.workspaceState.get<number>(LAST_SUCCESSFUL_FULL_UPDATE_KEY);
  let treeRefreshCount = 0;
  let requestedRefreshVersion = 0;
  let completedRefreshVersion = 0;
  let refreshLoop: Promise<TodoScanSummary> | undefined;
  let pendingFullUpdate = false;
  let runningFullUpdate = false;
  let cachePending = false;
  let disposed = false;
  let featureReady = false;
  let scanSettingsSignature = createScanSettingsSignature();
  const refreshPolicy = new TodoViewRefreshPolicy();

  const updateView = (summary?: TodoScanSummary, kind: TodoViewUpdateKind = 'incremental'): void => {
    if (summary !== undefined) latestSummary = summary;
    const effectiveSummary = summary ?? latestSummary;
    const settings = getTodoSettings();
    const filterActive = provider.filter.trim().length > 0;
    const scopeLabel = provider.scope === 'workspace' ? '工作区' : '当前文件';
    const markerScope = settings.showProjectMarkers ? '个人与项目标记' : '仅个人标记';
    view.description = `${scopeLabel} · ${markerScope} · ${provider.grouping === 'category' ? '按任务描述' : '按标签'}${filterActive ? ' · 已筛选' : ''}`;
    if (!settings.enabled) {
      view.message = '代码 TODO 已关闭。可从“配置”视图重新开启。';
    } else if (!settings.showProjectMarkers && settings.owner === undefined) {
      view.message = '尚未设置个人标记标识。设置后只扫描属于你的标记；项目已有标记默认不会扫描。';
    } else if (cancellation !== undefined) {
      if (effectiveSummary?.phase === 'openFiles' || effectiveSummary?.phase === 'scanning') {
        view.message = `${effectiveSummary.updateKind === 'incremental' ? '校验中' : '更新中'}：${effectiveSummary.files + effectiveSummary.skippedFiles}/${effectiveSummary.candidateFiles} 个文件 · ${effectiveSummary.results} 条标记`;
      } else {
        view.message = runningFullUpdate ? '正在准备完整更新…'
          : cachePending ? `已恢复 ${provider.totalResultCount} 条历史标记 · 正在校验文件变化…` : '正在检查缓存与文件变化…';
      }
    } else if (effectiveSummary?.phase === 'failed') {
      const retained = effectiveSummary.stale === true
        ? `已保留 ${effectiveSummary.results} 条已有结果。`
        : '当前没有可保留的历史结果。';
      view.message = `更新失败（${effectiveSummary.error ?? '未知错误'}）。${retained}`;
    } else if (effectiveSummary?.cancelled === true) {
      view.message = `更新已取消 · 保留 ${provider.totalResultCount} 条标记`;
    } else if (effectiveSummary?.limit === 'results') {
      view.message = `显示 ${effectiveSummary.results} 条部分结果 · 已达到安全上限`;
    } else if (cachePending) {
      view.message = `已恢复 ${provider.totalResultCount} 条历史标记 · 待校验`;
    } else if (filterActive && provider.visibleResultCount === 0 && provider.totalResultCount > 0) {
      view.message = `筛选“${provider.filter.trim()}”没有匹配结果；可使用标题栏的“清除 TODO 筛选”恢复全部 ${provider.totalResultCount} 条标记。`;
    } else if (hasCompletedScan && provider.totalResultCount === 0) {
      view.message = `${settings.showProjectMarkers ? '未发现标记' : '未发现个人标记'} · ${formatTodoFreshness(lastSuccessfulFullUpdateAt)}`;
    } else if (effectiveSummary?.phase === 'complete' || hasCompletedScan) {
      view.message = `${provider.visibleResultCount} 条标记 · ${formatTodoFreshness(lastSuccessfulFullUpdateAt)}`;
    } else if (!hasCompletedScan) {
      view.message = `正在等待首次完整更新 · ${formatTodoFreshness(lastSuccessfulFullUpdateAt)}`;
    }
    if (settings.enabled && cancellation === undefined && (effectiveSummary?.oversizedFiles ?? 0) > 0) {
      view.message += ` · 已跳过 ${effectiveSummary!.oversizedFiles} 个超大文件（>2 MiB）`;
    }
    if (refreshPolicy.shouldRefreshTree(kind)) {
      treeRefreshCount += 1;
      provider.refresh();
    }
  };

  interface QueuedResourceUpdate {
    readonly uri: vscode.Uri;
    readonly deleted: boolean;
    readonly live: boolean;
  }
  const updateQueue = new TodoUpdateQueue<QueuedResourceUpdate>(async (_key, update) => {
    if (update.deleted) scanner.removeUri(update.uri);
    else await scanner.scanUri(update.uri);
    updateView(undefined, update.live ? 'live' : 'incremental');
  }, {
    delayMs: 160,
    batchDelayMs: 60,
    batchSize: 8,
    concurrency: 2,
    onError(key, error) {
      output.appendLine(`TODO 后台更新失败 ${key}：${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const runRefresh = async (targetVersion: number): Promise<TodoScanSummary> => {
    runningFullUpdate = pendingFullUpdate;
    pendingFullUpdate = false;
    const source = new vscode.CancellationTokenSource();
    cancellation = source;
    latestSummary = undefined;
    hasCompletedScan = false;
    let completedSummary: TodoScanSummary | undefined;
    await vscode.commands.executeCommand('setContext', 'projectManager.todoScanning', true);
    updateView(undefined, 'start');
    try {
      completedSummary = provider.scope === 'currentFile' || vscode.workspace.workspaceFolders === undefined
        ? await scanner.scanCurrentFile(source.token)
        : await (runningFullUpdate ? scanner.scanWorkspace.bind(scanner) : scanner.updateWorkspace.bind(scanner))(source.token, (progress) => {
          updateView(progress, progress.phase === 'openFiles' ? 'openFiles' : 'progress');
        });
      return completedSummary;
    } finally {
      if (cancellation === source) {
        cancellation = undefined;
        if (targetVersion >= requestedRefreshVersion) {
          hasCompletedScan = true;
          cachePending = completedSummary?.stale === true || completedSummary?.cancelled === true;
          if (
            completedSummary?.phase === 'complete'
            && !completedSummary.cancelled
            && !completedSummary.truncated
            && !completedSummary.stale
            && (runningFullUpdate || completedSummary.updateKind === 'full')
            && provider.scope === 'workspace'
            && vscode.workspace.workspaceFolders !== undefined
          ) {
            lastSuccessfulFullUpdateAt = Date.now();
            await context.workspaceState.update(LAST_SUCCESSFUL_FULL_UPDATE_KEY, lastSuccessfulFullUpdateAt);
          }
          await vscode.commands.executeCommand('setContext', 'projectManager.todoScanning', false);
          updateView(completedSummary ?? {
            files: index.size,
            candidateFiles: index.size,
            discoveredFiles: index.size,
            skippedFiles: 0,
            results: index.values().reduce((sum, entry) => sum + entry.matches.length, 0),
            truncated: false,
            cancelled: source.token.isCancellationRequested,
            phase: 'complete',
            backend: provider.scope === 'currentFile' ? 'currentFile' : 'vscode',
          }, 'complete');
        }
        source.dispose();
      } else {
        source.dispose();
      }
    }
  };

  // OOM 修复约束：先等本轮扫描 Promise 收尾，再处理合并后的最新请求。
  // cancel 只是发出取消信号；不能在每个刷新事件中另启一轮扫描并让输出缓存同时增长。
  const runRefreshLoop = async (): Promise<TodoScanSummary> => {
    let summary: TodoScanSummary | undefined;
    do {
      const targetVersion = requestedRefreshVersion;
      summary = await runRefresh(targetVersion);
      completedRefreshVersion = targetVersion;
    } while (!disposed && completedRefreshVersion < requestedRefreshVersion);
    return summary;
  };

  // 原测试/内部 API 默认完整更新；普通用户刷新和启动显式传 false。
  const refresh = (forceFull = true): Promise<TodoScanSummary> => {
    requestedRefreshVersion += 1;
    pendingFullUpdate ||= forceFull || (cancellation !== undefined && runningFullUpdate);
    cancellation?.cancel();
    if (refreshLoop !== undefined) return refreshLoop;
    const loop = runRefreshLoop();
    refreshLoop = loop;
    void loop.then(
      () => { if (refreshLoop === loop) refreshLoop = undefined; },
      () => { if (refreshLoop === loop) refreshLoop = undefined; },
    );
    return loop;
  };

  const updateWatcher = (): void => {
    const settings = getTodoSettings();
    const shouldWatch = provider.scope === 'workspace'
      && settings.enabled
      && (settings.showProjectMarkers || settings.ownerIdentities.length > 0);
    if (!shouldWatch) {
      watcher?.dispose();
      watcher = undefined;
      return;
    }
    if (watcher !== undefined) return;
    watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const updateResource = (uri: vscode.Uri, deleted = false): void => {
      if (vscode.workspace.getWorkspaceFolder(uri) === undefined) return;
      if (!deleted && createTodoParseOptionsForPath(uri.path, getTodoSettings()) === undefined) return;
      updateQueue.enqueue(uri.toString(), { uri, deleted, live: false });
    };
    watcher.onDidCreate((uri) => updateResource(uri));
    watcher.onDidChange((uri) => updateResource(uri));
    watcher.onDidDelete((uri) => updateResource(uri, true));
  };

  const isRelevantDocument = (document: vscode.TextDocument): boolean => {
    if (!getTodoSettings().enabled) return false;
    if (provider.scope === 'currentFile') return document === vscode.window.activeTextEditor?.document;
    return vscode.workspace.getWorkspaceFolder(document.uri) !== undefined;
  };

  // 标记命令与文档事件共用实时更新入口，使未保存的新增、删除和编辑立即进入索引。
  const refreshDocumentNow = (document: vscode.TextDocument): void => {
    const key = document.uri.toString();
    const timer = documentTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    documentTimers.delete(key);
    if (!isRelevantDocument(document)) return;
    if (provider.scope === 'currentFile') index.clear();
    scanner.scanDocument(document);
    updateView(undefined, 'live');
  };

  const scheduleDocumentRefresh = (document: vscode.TextDocument): void => {
    if (!isRelevantDocument(document)) return;
    const key = document.uri.toString();
    const previous = documentTimers.get(key);
    if (previous !== undefined) clearTimeout(previous);
    documentTimers.set(key, setTimeout(() => {
      documentTimers.delete(key);
      refreshDocumentNow(document);
    }, 140));
  };

  const scheduleActiveDocumentRefresh = (): void => {
    const document = vscode.window.activeTextEditor?.document;
    if (document !== undefined) scheduleDocumentRefresh(document);
  };

  const openResult = async (node?: TodoTreeNode): Promise<void> => {
    if (node?.kind !== 'result') return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(node.resource.uri));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const range = new vscode.Range(
      node.match.line, node.match.startCharacter,
      node.match.line, node.match.endCharacter,
    );
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };

  const editResult = async (node: TodoTreeNode | undefined, edit: () => Promise<boolean>): Promise<boolean> => {
    if (node?.kind === 'result') await openResult(node);
    const changed = await edit();
    const document = vscode.window.activeTextEditor?.document;
    if (changed && document !== undefined) refreshDocumentNow(document);
    return changed;
  };

  const editActiveDocument = async (edit: () => Promise<boolean>): Promise<boolean> => editResult(undefined, edit);

  const manageTags = async (): Promise<void> => {
    const current = getTodoSettings().tagNames;
    if (featureSource.projectContext.kind === 'member' && featureSource.currentProjectTodoSettings?.tags !== undefined) {
      const action = await vscode.window.showQuickPick([
        { label: '修改当前集合关键词', value: 'edit' as const },
        { label: '跟随个人默认', description: '移除当前集合的关键词覆盖值', value: 'inherit' as const },
      ], { title: '管理代码 TODO 关键词' });
      if (action === undefined) return;
      if (action.value === 'inherit') {
        await featureSource.updateCurrentTodoTags(undefined);
        return;
      }
    }
    const choices = getAllTodoTagChoices(current);
    const selected = await vscode.window.showQuickPick(choices.map((choice) => ({
      label: choice.label,
      description: choice.enabled ? '已启用' : '可选预置',
      picked: choice.enabled,
      name: choice.name,
    })), { title: '管理代码 TODO 关键词', placeHolder: '选择需要识别和快速标记的关键词', canPickMany: true });
    if (selected === undefined || selected.length === 0) return;
    const tags = selected.map((item) => item.name);
    if (featureSource.projectContext.kind === 'member') {
      await featureSource.updateCurrentTodoTags(tags);
    } else {
      await vscode.workspace.getConfiguration('projectManager.todo').update('tags', tags, vscode.ConfigurationTarget.Global);
    }
  };

  const addTag = async (): Promise<void> => {
    const value = await vscode.window.showInputBox({
      title: '添加自定义 TODO 关键词',
      prompt: '允许字母、数字、下划线和连字符，最多 32 个字符；不支持正则表达式。',
      validateInput(input) { return normalizeTodoTagName(input) === undefined ? '请输入有效的简单关键词。' : undefined; },
    });
    const name = normalizeTodoTagName(value);
    if (name === undefined) return;
    const next = normalizeTodoTagNames([...getTodoSettings().tagNames, name]);
    if (featureSource.projectContext.kind === 'member') {
      await featureSource.updateCurrentTodoTags(next);
    } else {
      await vscode.workspace.getConfiguration('projectManager.todo').update('tags', next, vscode.ConfigurationTarget.Global);
    }
  };

  const chooseScope = async (): Promise<void> => {
    const selected = await vscode.window.showQuickPick([
      { label: '工作区', value: 'workspace' as const, description: provider.scope === 'workspace' ? '当前范围' : '' },
      { label: '当前文件', value: 'currentFile' as const, description: provider.scope === 'currentFile' ? '当前范围' : '' },
    ], { title: '选择代码 TODO 扫描范围' });
    if (selected === undefined || selected.value === provider.scope) return;
    provider.scope = selected.value;
    updateWatcher();
    await refresh(false);
  };

  const chooseGrouping = async (): Promise<void> => {
    const selected = await vscode.window.showQuickPick([
      { label: '按任务描述', value: 'category' as const }, { label: '按标签', value: 'tag' as const },
    ], { title: '选择代码 TODO 分组方式' });
    if (selected === undefined) return;
    provider.grouping = selected.value;
    updateView(undefined, 'incremental');
  };

  const setFilter = async (): Promise<void> => {
    const value = await vscode.window.showInputBox({
      title: '筛选代码 TODO', value: provider.filter,
      prompt: '匹配关键词、正文、文件名或相对路径；留空清除筛选。',
    });
    if (value === undefined) return;
    provider.filter = value;
    await vscode.commands.executeCommand('setContext', 'projectManager.todoFilterActive', provider.filter.trim().length > 0);
    updateView(undefined, 'incremental');
  };

  const clearFilter = async (): Promise<void> => {
    if (provider.filter.length === 0) return;
    provider.filter = '';
    await vscode.commands.executeCommand('setContext', 'projectManager.todoFilterActive', false);
    updateView(undefined, 'incremental');
  };

  const handleEffectiveSettingsChange = (): void => {
    decorations.updateVisible();
    const settings = getTodoSettings();
    const nextScanSettingsSignature = createScanSettingsSignature();
    const scanSettingsChanged = nextScanSettingsSignature !== scanSettingsSignature;
    scanSettingsSignature = nextScanSettingsSignature;
    if (!featureReady) {
      updateView(undefined, 'incremental');
      return;
    }
    updateWatcher();
    if (!settings.enabled) {
      cancellation?.cancel();
      index.clear();
      hasCompletedScan = false;
      latestSummary = undefined;
      updateView(undefined, 'incremental');
      return;
    }
    if (scanSettingsChanged) {
      scanner.invalidateCache();
      void refresh();
    }
    else updateView(undefined, 'live');
  };

  context.subscriptions.push(
    provider, view, decorations,
    updateQueue,
    {
      dispose() {
        disposed = true;
        for (const timer of documentTimers.values()) clearTimeout(timer);
        documentTimers.clear();
        cancellation?.cancel();
        cancellation?.dispose();
        watcher?.dispose();
      },
    },
    view.onDidChangeVisibility((event) => {
      if (event.visible) updateView(undefined, 'live');
    }),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      if (provider.scope !== 'workspace') return;
      for (const tab of event.closed) {
        if (!(tab.input instanceof vscode.TabInputText)) continue;
        const uri = tab.input.uri;
        if (vscode.workspace.getWorkspaceFolder(uri) === undefined) continue;
        updateQueue.enqueue(uri.toString(), { uri, deleted: false, live: false }, 1);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(scheduleActiveDocumentRefresh),
    vscode.window.onDidChangeVisibleTextEditors(() => decorations.updateVisible()),
    vscode.workspace.onDidOpenTextDocument(scheduleDocumentRefresh),
    vscode.workspace.onDidChangeTextDocument((event) => {
      decorations.updateDocument(event.document);
      scheduleDocumentRefresh(event.document);
    }),
    vscode.workspace.onDidSaveTextDocument(refreshDocumentNow),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      const timer = documentTimers.get(key);
      if (timer !== undefined) clearTimeout(timer);
      documentTimers.delete(key);
      if (provider.scope === 'workspace' && vscode.workspace.getWorkspaceFolder(document.uri) !== undefined) {
        updateQueue.enqueue(key, { uri: document.uri, deleted: false, live: false }, 1);
      } else if (provider.scope === 'currentFile') {
        void refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!['projectManager.todo', 'files.exclude', 'search.exclude', 'files.encoding', 'files.associations']
        .some((key) => event.affectsConfiguration(key))) return;
      handleEffectiveSettingsChange();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(handleEffectiveSettingsChange),
    featureSource.onDidChange(handleEffectiveSettingsChange),
    vscode.commands.registerCommand('projectManager.todo.refresh', () => refresh(false)),
    vscode.commands.registerCommand('projectManager.todo.fullRefresh', () => refresh(true)),
    vscode.commands.registerCommand('projectManager.todo.cancel', () => cancellation?.cancel()),
    vscode.commands.registerCommand('projectManager.todo.selectScope', chooseScope),
    vscode.commands.registerCommand('projectManager.todo.selectGrouping', chooseGrouping),
    vscode.commands.registerCommand('projectManager.todo.filter', setFilter),
    vscode.commands.registerCommand('projectManager.todo.clearFilter', clearFilter),
    vscode.commands.registerCommand('projectManager.todo.open', openResult),
    vscode.commands.registerCommand('projectManager.todo.manageTags', manageTags),
    vscode.commands.registerCommand('projectManager.todo.addTag', addTag),
    vscode.commands.registerCommand('projectManager.todo.configureOwner', () => marker.configureOwner()),
    vscode.commands.registerCommand('projectManager.todo.quickMark', () => editActiveDocument(() => marker.quickMark(false))),
    vscode.commands.registerCommand('projectManager.todo.repeatLastMark', () => editActiveDocument(() => marker.quickMark(true))),
    vscode.commands.registerCommand('projectManager.todo.changeMark', (node?: TodoTreeNode) => editResult(node, () => marker.changeMark())),
    vscode.commands.registerCommand('projectManager.todo.toggleCompleted', (node?: TodoTreeNode) => editResult(node, () => marker.toggleCompleted())),
    vscode.commands.registerCommand('projectManager.todo.removeMark', (node?: TodoTreeNode) => editResult(node, () => marker.removeMark())),
    vscode.commands.registerCommand('projectManager.todo.assignToMe', (node?: TodoTreeNode) => editResult(node, () => marker.assignToMe())),
    vscode.commands.registerCommand('projectManager.todo.unassignMine', (node?: TodoTreeNode) => editResult(node, () => marker.unassignMine())),
    vscode.commands.registerCommand('projectManager.todo.configureShortcuts', async () => {
      await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', '@command:projectManager.todo.quickMark');
    }),
  );

  void vscode.commands.executeCommand('setContext', 'projectManager.todoScanning', false);
  void vscode.commands.executeCommand('setContext', 'projectManager.todoFilterActive', false);
  updateView();
  decorations.updateVisible();
  const startupRefresh = initialization.then(() => {
    if (disposed) return undefined;
    featureReady = true;
    scanSettingsSignature = createScanSettingsSignature();
    cachePending = scanner.restoreCache();
    updateWatcher();
    updateView(undefined, 'incremental');
    return getTodoSettings().enabled ? refresh(false) : undefined;
  }).catch((error) => {
      output.appendLine(`TODO 启动更新失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
  return {
    index, scanner, provider, marker, decorations, view, refresh,
    isScanning: () => cancellation !== undefined,
    getLastSummary: () => latestSummary,
    getTreeRefreshCount: () => treeRefreshCount,
    waitForIdleForIntegrationTest: async () => {
      await startupRefresh;
      await updateQueue.whenIdle();
      while (refreshLoop !== undefined) {
        await refreshLoop.catch(() => undefined);
      }
      await updateQueue.whenIdle();
    },
  };
}

function createScanSettingsSignature(): string {
  return todoCacheSignature();
}
