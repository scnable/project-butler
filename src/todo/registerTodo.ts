import * as vscode from 'vscode';
import { ProjectFeatureConfigurationSource } from '../configuration/configurationTypes';
import { TodoIndex } from './todoIndex';
import { TodoDecorations } from './todoDecorations';
import { TodoMarker } from './todoMarker';
import { TodoScanner, TodoScanSummary } from './todoScanner';
import { todoScanBackendLabel } from './todoSearchBackend';
import { getTodoSettings } from './todoSettings';
import { getAllTodoTagChoices, normalizeTodoTagName, normalizeTodoTagNames } from './todoTags';
import { TodoTreeNode, TodoTreeProvider } from './todoTreeProvider';
import { TodoViewRefreshPolicy, TodoViewUpdateKind } from './todoViewRefreshPolicy';

export interface RegisteredTodo {
  readonly index: TodoIndex;
  readonly scanner: TodoScanner;
  readonly provider: TodoTreeProvider;
  readonly marker: TodoMarker;
  readonly decorations: TodoDecorations;
  readonly view: vscode.TreeView<TodoTreeNode>;
  readonly refresh: () => Promise<TodoScanSummary>;
  readonly isScanning: () => boolean;
  readonly getLastSummary: () => TodoScanSummary | undefined;
  readonly getTreeRefreshCount: () => number;
}

export function registerTodo(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  featureSource: ProjectFeatureConfigurationSource,
): RegisteredTodo {
  const index = new TodoIndex();
  const scanner = new TodoScanner(index, output);
  const provider = new TodoTreeProvider(index);
  const marker = new TodoMarker(context.workspaceState);
  const decorations = new TodoDecorations();
  const view = vscode.window.createTreeView('projectManager.todoView', { treeDataProvider: provider, showCollapseAll: true });
  let cancellation: vscode.CancellationTokenSource | undefined;
  let documentTimer: ReturnType<typeof setTimeout> | undefined;
  let watcher: vscode.FileSystemWatcher | undefined;
  let latestSummary: TodoScanSummary | undefined;
  let hasCompletedScan = false;
  let treeRefreshCount = 0;
  const pendingResources = new Map<string, { readonly uri: vscode.Uri; readonly deleted: boolean }>();
  const refreshPolicy = new TodoViewRefreshPolicy();

  const updateView = (summary?: TodoScanSummary, kind: TodoViewUpdateKind = 'incremental'): void => {
    if (summary !== undefined) latestSummary = summary;
    const effectiveSummary = summary ?? latestSummary;
    const settings = getTodoSettings();
    const filterActive = provider.filter.trim().length > 0;
    const scopeLabel = provider.scope === 'workspace' ? '工作区' : '当前文件';
    view.description = `${scopeLabel} · ${provider.grouping === 'file' ? '按文件' : '按标签'}${filterActive ? ' · 已筛选' : ''}`;
    if (!settings.enabled) {
      view.message = '代码 TODO 已关闭。可从“配置”视图重新开启。';
    } else if (cancellation !== undefined) {
      if (effectiveSummary?.phase === 'openFiles') {
        view.message = `已先扫描 ${effectiveSummary.files} 个打开文件并找到 ${effectiveSummary.results} 条，正在准备工作区快速搜索；可以从标题栏取消。`;
      } else if (effectiveSummary?.phase === 'scanning') {
        view.message = `正在使用${todoScanBackendLabel(effectiveSummary.backend)}处理 ${effectiveSummary.files + effectiveSummary.skippedFiles}/${effectiveSummary.candidateFiles} 个候选源码（从 ${effectiveSummary.discoveredFiles} 个源码中筛选），已找到 ${effectiveSummary.results} 条；可以从标题栏取消。`;
      } else {
        view.message = '正在枚举源码并选择最快的可用搜索后端，可以从标题栏取消。';
      }
    } else if (effectiveSummary?.phase === 'failed') {
      const retained = effectiveSummary.stale === true
        ? `已保留上次的 ${effectiveSummary.results} 条结果，这些结果可能已过期。`
        : '当前没有可保留的历史结果。';
      view.message = `扫描失败（${effectiveSummary.error ?? '未知错误'}）。${retained}请从标题栏重试。`;
    } else if (effectiveSummary?.cancelled === true) {
      view.message = `扫描已取消：已处理 ${effectiveSummary.files + effectiveSummary.skippedFiles}/${effectiveSummary.candidateFiles} 个候选源码，保留 ${effectiveSummary.results} 条结果。`;
    } else if (effectiveSummary?.limit === 'results') {
      view.message = `显示 ${effectiveSummary.results} 条部分结果：已达到结果数量上限；已处理 ${effectiveSummary.files + effectiveSummary.skippedFiles}/${effectiveSummary.candidateFiles} 个候选源码。`;
    } else if (filterActive && provider.visibleResultCount === 0 && provider.totalResultCount > 0) {
      view.message = `筛选“${provider.filter.trim()}”没有匹配结果；可使用标题栏的“清除 TODO 筛选”恢复全部 ${provider.totalResultCount} 条标记。`;
    } else if (hasCompletedScan && provider.totalResultCount === 0) {
      view.message = `没有找到标记。范围：${scopeLabel}；当前关键词：${settings.tagNames.join('、')}。可从标题栏管理关键词。`;
    } else if (effectiveSummary?.phase === 'complete') {
      const skipped = effectiveSummary.skippedFiles > 0 ? `，跳过 ${effectiveSummary.skippedFiles} 个不可读文件` : '';
      view.message = `扫描完成（${todoScanBackendLabel(effectiveSummary.backend)}）：从 ${effectiveSummary.discoveredFiles} 个源码中筛选并处理 ${effectiveSummary.candidateFiles} 个候选，找到 ${effectiveSummary.results} 条${skipped}。`;
    } else if (!hasCompletedScan) {
      view.message = '尚未扫描。展开此视图后会自动扫描，也可以从标题栏手动刷新。';
    } else {
      view.message = `当前显示 ${provider.visibleResultCount} 条标记。`;
    }
    if (refreshPolicy.shouldRefreshTree(kind)) {
      treeRefreshCount += 1;
      provider.refresh();
    }
  };

  const flushPendingResources = async (): Promise<void> => {
    const pending = [...pendingResources.values()];
    pendingResources.clear();
    for (const resource of pending) {
      if (resource.deleted) {
        index.remove(resource.uri.toString());
      } else {
        await scanner.scanUri(resource.uri);
      }
    }
  };

  const refresh = async (): Promise<TodoScanSummary> => {
    cancellation?.cancel();
    cancellation?.dispose();
    if (documentTimer !== undefined) {
      clearTimeout(documentTimer);
      documentTimer = undefined;
    }
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
        : await scanner.scanWorkspace(source.token, (progress) => {
          updateView(progress, progress.phase === 'openFiles' ? 'openFiles' : 'progress');
        });
      return completedSummary;
    } finally {
      if (cancellation === source) {
        cancellation = undefined;
        source.dispose();
        await flushPendingResources();
        hasCompletedScan = true;
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
      } else {
        source.dispose();
      }
    }
  };

  const updateWatcher = (): void => {
    const shouldWatch = view.visible && provider.scope === 'workspace' && getTodoSettings().enabled;
    if (!shouldWatch) {
      watcher?.dispose();
      watcher = undefined;
      return;
    }
    if (watcher !== undefined) return;
    watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const updateResource = async (uri: vscode.Uri, deleted = false): Promise<void> => {
      if (vscode.workspace.getWorkspaceFolder(uri) === undefined) return;
      if (cancellation !== undefined) {
        pendingResources.set(uri.toString(), { uri, deleted });
        return;
      }
      if (deleted) index.remove(uri.toString());
      else await scanner.scanUri(uri);
      updateView(undefined, 'incremental');
    };
    watcher.onDidCreate((uri) => { void updateResource(uri); });
    watcher.onDidChange((uri) => { void updateResource(uri); });
    watcher.onDidDelete((uri) => { void updateResource(uri, true); });
  };

  const scheduleCurrentDocumentRefresh = (): void => {
    if (!view.visible) return;
    if (documentTimer !== undefined) clearTimeout(documentTimer);
    documentTimer = setTimeout(() => {
      documentTimer = undefined;
      const document = vscode.window.activeTextEditor?.document;
      if (document === undefined) return;
      if (provider.scope === 'currentFile') {
        void refresh();
      } else if (vscode.workspace.getWorkspaceFolder(document.uri) !== undefined) {
        void scanner.scanUri(document.uri).then(() => updateView(undefined, 'incremental'));
      }
    }, 250);
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
    return edit();
  };

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
    await refresh();
  };

  const chooseGrouping = async (): Promise<void> => {
    const selected = await vscode.window.showQuickPick([
      { label: '按文件', value: 'file' as const }, { label: '按标签', value: 'tag' as const },
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
    updateWatcher();
    if (view.visible) {
      void refresh();
    } else {
      index.clear();
      hasCompletedScan = false;
      latestSummary = undefined;
      updateView(undefined, 'incremental');
    }
  };

  context.subscriptions.push(
    provider, view, decorations,
    { dispose() { if (documentTimer !== undefined) clearTimeout(documentTimer); cancellation?.cancel(); cancellation?.dispose(); watcher?.dispose(); } },
    view.onDidChangeVisibility((event) => {
      updateWatcher();
      if (event.visible && !hasCompletedScan) void refresh();
      if (!event.visible) cancellation?.cancel();
    }),
    vscode.window.onDidChangeActiveTextEditor(scheduleCurrentDocumentRefresh),
    vscode.window.onDidChangeVisibleTextEditors(() => decorations.updateVisible()),
    vscode.workspace.onDidChangeTextDocument((event) => {
      decorations.updateDocument(event.document);
      if (event.document === vscode.window.activeTextEditor?.document) scheduleCurrentDocumentRefresh();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (view.visible && provider.scope === 'currentFile' && document === vscode.window.activeTextEditor?.document) {
        scanner.scanDocument(document); updateView(undefined, 'incremental');
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('projectManager.todo')) return;
      handleEffectiveSettingsChange();
    }),
    featureSource.onDidChange(handleEffectiveSettingsChange),
    vscode.commands.registerCommand('projectManager.todo.refresh', refresh),
    vscode.commands.registerCommand('projectManager.todo.cancel', () => cancellation?.cancel()),
    vscode.commands.registerCommand('projectManager.todo.selectScope', chooseScope),
    vscode.commands.registerCommand('projectManager.todo.selectGrouping', chooseGrouping),
    vscode.commands.registerCommand('projectManager.todo.filter', setFilter),
    vscode.commands.registerCommand('projectManager.todo.clearFilter', clearFilter),
    vscode.commands.registerCommand('projectManager.todo.open', openResult),
    vscode.commands.registerCommand('projectManager.todo.manageTags', manageTags),
    vscode.commands.registerCommand('projectManager.todo.addTag', addTag),
    vscode.commands.registerCommand('projectManager.todo.configureOwner', () => marker.configureOwner()),
    vscode.commands.registerCommand('projectManager.todo.quickMark', () => marker.quickMark(false)),
    vscode.commands.registerCommand('projectManager.todo.repeatLastMark', () => marker.quickMark(true)),
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
  updateWatcher();
  decorations.updateVisible();
  return {
    index, scanner, provider, marker, decorations, view, refresh,
    isScanning: () => cancellation !== undefined,
    getLastSummary: () => latestSummary,
    getTreeRefreshCount: () => treeRefreshCount,
  };
}
