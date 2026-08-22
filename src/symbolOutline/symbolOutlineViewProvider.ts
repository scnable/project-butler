import * as path from 'node:path';
import * as vscode from 'vscode';
import { ProjectFeatureConfigurationSource } from '../configuration/configurationTypes';
import {
  isEnhancedOutlineEnabled,
  OutlineMode,
  resolveNativeOutlineConflict,
  isNativeOutlineNoticeVisible,
} from './outlineMode';
import { resolveEffectiveOutlineMode } from './outlineSettings';
import {
  applyFunctionMetrics,
  countSymbols,
  createEditKey,
  createSymbolId,
  findCurrentSymbol,
  flattenSymbols,
  getOutlineDisplayName,
  OutlineHierarchy,
  OutlineRange,
  OutlineScope,
  OutlineSort,
  OutlineSymbol,
  projectSymbols,
} from './symbolModel';
import { getSymbolOutlineHtml } from './webviewHtml';
import { enhanceOutlineSymbols } from './outlineEnhancements';
import { hasVscodeCommand } from '../platform/vscodeCapabilities';
import { getIconResourceRoot } from '../visual/webviewIconResources';
import { IconStyle, normalizeIconStyle } from '../visual/iconStyle';

type OutlineAppearance = 'vscode' | 'sourceInsightLight' | 'sourceInsightBlack';
type OutlineStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'excluded' | 'unsupported' | 'error';

interface OutlinePreferences {
  mode: OutlineMode;
  followActiveEditor: boolean;
  scope: OutlineScope;
  hierarchy: OutlineHierarchy;
  sort: OutlineSort;
  appearance: OutlineAppearance;
  showLineMetrics: boolean;
  highlightLongFunctions: boolean;
  highlightEditedSymbols: boolean;
  scale: number;
  iconStyle: IconStyle;
}

interface CachedSymbols {
  version: number;
  symbols: OutlineSymbol[];
}

export interface OutlineViewState {
  status: OutlineStatus;
  message: string;
  fileName: string;
  filePath: string;
  languageId: string;
  external: boolean;
  dirty: boolean;
  following: boolean;
  query: string;
  currentId: string;
  totalCount: number;
  visibleCount: number;
  symbols: OutlineSymbol[];
  preferences: OutlinePreferences;
  nativeOutlineNotice: boolean;
  nativeOutlineNoticeExpanded: boolean;
}

const VIEW_ID = 'projectManager.symbolOutlineView';
const LEGACY_VIEW_ID = 'projectManager.enhancedSymbolOutlineView';
const PINNED_URI_KEY = 'projectManager.symbolOutline.pinnedUri';
const NATIVE_NOTICE_EXPANDED_KEY = 'projectManager.symbolOutline.nativeNoticeExpanded';
const LOCATION_HINT_KEY = 'projectManager.symbolOutline.locationHint.v4';
const MAX_CACHE_SIZE = 10;

export class SymbolOutlineViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new Map<string, CachedSymbols>();
  private readonly editedByDocument = new Map<string, Set<string>>();
  private view: vscode.WebviewView | undefined;
  private targetUri: vscode.Uri | undefined;
  private sourceViewColumn: vscode.ViewColumn | undefined;
  private currentSymbols: OutlineSymbol[] = [];
  private status: OutlineStatus = 'idle';
  private statusMessage = '打开源码文件后显示函数大纲。';
  private query = '';
  private requestSequence = 0;
  private documentTimer: ReturnType<typeof setTimeout> | undefined;
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  private jumpHighlightTimer: ReturnType<typeof setTimeout> | undefined;
  private jumpHighlightEditor: vscode.TextEditor | undefined;
  private readonly jumpHighlightDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    borderColor: new vscode.ThemeColor('editor.focusedStackFrameHighlightBackground'),
    borderStyle: 'solid',
    borderWidth: '1px 0',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.rangeHighlightForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  private lastMode: OutlineMode;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly catalogService: ProjectFeatureConfigurationSource,
  ) {
    this.lastMode = this.preferences.mode;
    const editor = vscode.window.activeTextEditor;
    this.targetUri = editor?.document.uri;
    this.sourceViewColumn = editor?.viewColumn;

    if (!this.preferences.followActiveEditor) {
      const savedUri = context.workspaceState.get<string>(PINNED_URI_KEY);
      if (savedUri !== undefined) {
        this.targetUri = vscode.Uri.parse(savedUri);
      }
    }

    this.disposables.push(
      this.jumpHighlightDecoration,
      vscode.window.onDidChangeActiveTextEditor((activeEditor) => this.handleActiveEditorChanged(activeEditor)),
      vscode.window.onDidChangeTextEditorSelection((event) => this.handleSelectionChanged(event)),
      vscode.workspace.onDidChangeTextDocument((event) => this.handleDocumentChanged(event)),
      vscode.workspace.onDidSaveTextDocument((document) => this.handleDocumentSaved(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.handleDocumentClosed(document)),
      vscode.workspace.onDidChangeConfiguration((event) => this.handleConfigurationChanged(event)),
      catalogService.onDidChange(() => this.handleCatalogChanged()),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [getIconResourceRoot(this.context.extensionUri)],
    };
    webviewView.webview.html = getSymbolOutlineHtml(
      webviewView.webview,
      this.context.extensionUri,
    );
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message)),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
        }
      }),
    );
    void this.refreshSymbols('视图已打开');
  }

  dispose(): void {
    if (this.documentTimer !== undefined) {
      clearTimeout(this.documentTimer);
    }
    if (this.selectionTimer !== undefined) {
      clearTimeout(this.selectionTimer);
    }
    if (this.jumpHighlightTimer !== undefined) {
      clearTimeout(this.jumpHighlightTimer);
    }
    this.jumpHighlightEditor?.setDecorations(this.jumpHighlightDecoration, []);
    this.disposables.splice(0).forEach((disposable) => disposable.dispose());
  }

  async refreshSymbols(reason: string): Promise<void> {
    const request = ++this.requestSequence;
    const uri = await this.resolveTargetUri();
    if (request !== this.requestSequence) {
      return;
    }
    if (uri === undefined) {
      this.currentSymbols = [];
      this.setStatus('idle', '打开源码文件后显示函数大纲。');
      await this.postState();
      return;
    }

    let document: vscode.TextDocument;
    try {
      document = await this.getDocument(uri);
    } catch (error) {
      this.currentSymbols = [];
      this.setStatus('error', '无法读取当前文件，可取消固定或重试。');
      this.output.appendLine(`[函数大纲] 读取文档失败：${uri.toString()}；${toErrorMessage(error)}`);
      await this.postState();
      return;
    }

    const cacheKey = uri.toString();
    const requestedVersion = document.version;
    const cached = this.cache.get(cacheKey);
    if (cached?.version === requestedVersion) {
      this.currentSymbols = this.withEditedState(cached.symbols, cacheKey);
      this.setStatus(this.currentSymbols.length === 0 ? 'empty' : 'ready', this.currentSymbols.length === 0
        ? '当前语言服务没有返回符号。'
        : '');
      await this.postState(document);
    } else {
      this.setStatus('loading', `正在读取符号…`);
      await this.postState(document);
    }

    try {
      const result = await vscode.commands.executeCommand<readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      );
      if (request !== this.requestSequence || this.targetUri?.toString() !== cacheKey) {
        return;
      }
      if (document.version !== requestedVersion) {
        void this.refreshSymbols('文档版本变化');
        return;
      }

      const matchingExclude = result === undefined || result.length === 0
        ? findMatchingFilesExclude(document)
        : undefined;
      if (matchingExclude !== undefined) {
        this.currentSymbols = [];
        this.setStatus(
          'excluded',
          `当前文件命中 files.exclude 规则“${matchingExclude}”。C/C++ 等语言服务可能不会为被屏蔽文件提供大纲符号。`,
        );
        this.output.appendLine(`[函数大纲] 当前文件被 files.exclude 屏蔽：${cacheKey}；规则：${matchingExclude}`);
        await this.postState(document);
        return;
      }

      if (result === undefined) {
        this.currentSymbols = [];
        this.setStatus('unsupported', `“${document.languageId}”当前没有可用的符号提供器，请安装或启用对应语言扩展。`);
        await this.postState(document);
        return;
      }

      const normalized = normalizeSymbols(result, cacheKey);
      const enhanced = applyFunctionMetrics(enhanceOutlineSymbols(
        normalized,
        document.getText(),
        document.languageId,
        cacheKey,
      ));
      this.rememberCache(cacheKey, { version: requestedVersion, symbols: enhanced });
      this.currentSymbols = this.withEditedState(enhanced, cacheKey);
      this.setStatus(enhanced.length === 0 ? 'empty' : 'ready', enhanced.length === 0
        ? '当前文件没有可显示的函数或符号。'
        : '');
      this.output.appendLine(`[函数大纲] ${reason}：${path.basename(document.fileName)}，${countSymbols(enhanced)} 个符号。`);
      await this.postState(document);
    } catch (error) {
      if (request !== this.requestSequence) {
        return;
      }
      this.currentSymbols = [];
      this.setStatus('error', '符号读取失败，请重试或检查对应语言扩展。');
      this.output.appendLine(`[函数大纲] 符号请求失败：${uri.toString()}；${toErrorMessage(error)}`);
      await this.postState(document);
    }
  }

  public getStateForIntegrationTest(): OutlineViewState {
    return this.createState();
  }

  public async setQueryForIntegrationTest(query: string): Promise<void> {
    this.query = query.slice(0, 200);
    await this.postState();
  }

  public async jumpToSymbolForIntegrationTest(id: string): Promise<void> {
    await this.jumpToSymbol(id);
  }

  public clearEditedForIntegrationTest(): void {
    const key = this.targetUri?.toString();
    if (key === undefined) return;
    this.editedByDocument.delete(key);
    this.currentSymbols = this.withEditedState(this.currentSymbols, key);
  }

  public markEditedForIntegrationTest(id: string): void {
    const key = this.targetUri?.toString();
    const symbol = flattenSymbols(this.currentSymbols).find((item) => item.id === id);
    if (key === undefined || symbol === undefined) return;
    const edited = this.editedByDocument.get(key) ?? new Set<string>();
    edited.add(symbol.editKey);
    this.editedByDocument.set(key, edited);
    this.currentSymbols = this.withEditedState(this.currentSymbols, key);
  }

  async selectAppearance(): Promise<void> {
    const current = this.preferences.appearance;
    const choices: readonly (vscode.QuickPickItem & { value: OutlineAppearance })[] = [
      {
        label: '$(color-mode) 跟随 VS Code',
        ...(current === 'vscode' ? { description: '当前使用' } : {}),
        detail: '使用当前 VS Code 主题的侧栏颜色和字体。',
        value: 'vscode',
      },
      {
        label: '$(symbol-color) Source Insight 浅色',
        ...(current === 'sourceInsightLight' ? { description: '当前使用' } : {}),
        detail: '灰白背景、深色文字和紧凑的 Windows 面板字体。',
        value: 'sourceInsightLight',
      },
      {
        label: '$(symbol-color) Source Insight 黑色',
        ...(current === 'sourceInsightBlack' ? { description: '当前使用' } : {}),
        detail: '深灰背景、浅色文字和蓝色当前函数强调。',
        value: 'sourceInsightBlack',
      },
    ];
    const selected = await vscode.window.showQuickPick(choices, {
      title: '选择函数大纲外观',
      placeHolder: '外观会立即应用，并保存到 VS Code 本机设置',
    });
    if (selected === undefined || selected.value === current) {
      return;
    }
    await vscode.workspace.getConfiguration('projectManager.symbolOutline')
      .update('appearance', selected.value, vscode.ConfigurationTarget.Global);
  }

  async selectMode(): Promise<void> {
    const current = this.preferences.mode;
    const editsCatalog = this.catalogService.projectContext.kind === 'member';
    const choices: readonly (vscode.QuickPickItem & { value: OutlineMode })[] = [
      {
        label: '$(list-tree) 仅使用增强大纲',
        ...(current === 'enhanced' ? { description: '当前使用' } : {}),
        detail: '增强大纲默认显示在“项目管家”插件侧栏；面板内会常驻提示如何手动隐藏原生大纲。',
        value: 'enhanced',
      },
      {
        label: '$(list-selection) 同时使用两个大纲',
        ...(current === 'both' ? { description: '当前使用' } : {}),
        detail: '保留 VS Code 原生大纲，同时显示增强函数大纲。',
        value: 'both',
      },
      {
        label: '$(outline-view-icon) 仅使用 VS Code 原生大纲',
        ...(current === 'native' ? { description: '当前使用' } : {}),
        detail: '隐藏增强函数大纲，并定位到 VS Code 原生大纲。',
        value: 'native',
      },
    ];
    const selected = await vscode.window.showQuickPick(choices, {
      title: editsCatalog ? '项目集合：选择大纲模式' : '个人偏好：选择大纲模式',
      placeHolder: editsCatalog
        ? '保存到当前项目集合配置文件，可随集合复制'
        : '当前窗口不是集合内项目，保存为全局个人默认值',
    });
    if (selected === undefined || selected.value === current) {
      return;
    }
    await this.applyMode(selected.value, true);
    if (this.preferences.mode !== 'native') {
      await focusEnhancedOutlineView();
    }
  }

  private get preferences(): OutlinePreferences {
    const configuration = vscode.workspace.getConfiguration('projectManager.symbolOutline');
    return {
      mode: resolveEffectiveOutlineMode(this.catalogService.currentProjectSymbolOutlineSettings).mode,
      followActiveEditor: true,
      scope: readEnum(configuration.get<string>('scope'), ['functions', 'functionsAndTypes', 'all'], 'functionsAndTypes'),
      hierarchy: 'tree',
      sort: readEnum(configuration.get<string>('sort'), ['source', 'name', 'typeName'], 'source'),
      appearance: readEnum(configuration.get<string>('appearance'), ['vscode', 'sourceInsightLight', 'sourceInsightBlack'], 'vscode'),
      showLineMetrics: configuration.get<boolean>('showLineMetrics', true),
      highlightLongFunctions: configuration.get<boolean>('highlightLongFunctions', true),
      highlightEditedSymbols: configuration.get<boolean>('highlightEditedSymbols', true),
      scale: clamp(configuration.get<number>('scale', 100), 90, 150),
      iconStyle: normalizeIconStyle(
        vscode.workspace.getConfiguration('projectManager.visuals').get<unknown>('iconStyle'),
      ),
    };
  }

  private async resolveTargetUri(): Promise<vscode.Uri | undefined> {
    if (this.preferences.followActiveEditor) {
      const editor = vscode.window.activeTextEditor;
      if (editor !== undefined) {
        this.targetUri = editor.document.uri;
        this.sourceViewColumn = editor.viewColumn;
      }
    }
    return this.targetUri;
  }

  private async getDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
    return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
      ?? vscode.workspace.openTextDocument(uri);
  }

  private handleActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    if (editor === undefined) {
      return;
    }
    this.sourceViewColumn = editor.viewColumn;
    if (!this.preferences.followActiveEditor) {
      return;
    }
    this.targetUri = editor.document.uri;
    void this.refreshSymbols('切换活动文件');
  }

  private handleSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    if (event.textEditor.document.uri.toString() !== this.targetUri?.toString()) {
      return;
    }
    if (this.selectionTimer !== undefined) {
      clearTimeout(this.selectionTimer);
    }
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = undefined;
      const current = findCurrentSymbol(this.currentSymbols, event.selections[0]?.active ?? { line: 0, character: 0 });
      void this.view?.webview.postMessage({ type: 'current', currentId: current?.id ?? '' });
    }, 50);
  }

  private handleDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    const key = event.document.uri.toString();
    if (key !== this.targetUri?.toString()) {
      return;
    }

    if (this.preferences.highlightEditedSymbols) {
      const edited = this.editedByDocument.get(key) ?? new Set<string>();
      for (const change of event.contentChanges) {
        const symbol = findCurrentSymbol(this.currentSymbols, change.range.start);
        if (symbol !== undefined) {
          edited.add(symbol.editKey);
        }
      }
      this.editedByDocument.set(key, edited);
    }

    if (this.documentTimer !== undefined) {
      clearTimeout(this.documentTimer);
    }
    this.documentTimer = setTimeout(() => {
      this.documentTimer = undefined;
      void this.refreshSymbols('文档内容变化');
    }, 250);
  }

  private handleDocumentSaved(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    if (!this.editedByDocument.delete(key) || key !== this.targetUri?.toString()) {
      return;
    }
    this.currentSymbols = this.withEditedState(this.currentSymbols, key);
    void this.postState(document);
  }

  private handleDocumentClosed(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.cache.delete(key);
    this.editedByDocument.delete(key);
  }

  private handleConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
    const outlineChanged = event.affectsConfiguration('projectManager.symbolOutline');
    const filesExcludeChanged = event.affectsConfiguration('files.exclude');
    const visualsChanged = event.affectsConfiguration('projectManager.visuals.iconStyle');
    if (!outlineChanged && !filesExcludeChanged && !visualsChanged) {
      return;
    }
    if (visualsChanged && !outlineChanged && !filesExcludeChanged) {
      void this.postState();
      return;
    }
    if (outlineChanged && this.preferences.followActiveEditor) {
      const editor = vscode.window.activeTextEditor;
      this.targetUri = editor?.document.uri;
      this.sourceViewColumn = editor?.viewColumn;
    }
    void this.refreshAfterModeChange(filesExcludeChanged ? '目录屏蔽设置变化' : '设置变化');
  }

  private handleCatalogChanged(): void {
    void this.refreshAfterModeChange('项目集合配置变化');
  }

  private async refreshAfterModeChange(reason: string): Promise<void> {
    const nextMode = this.preferences.mode;
    if (nextMode !== this.lastMode) {
      this.lastMode = nextMode;
    }
    await this.refreshSymbols(reason);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'ready':
        await this.postState();
        return;
      case 'refresh':
        await this.refreshSymbols('手动刷新');
        return;
      case 'openOutlineSettings':
        await vscode.commands.executeCommand('projectManager.configurationView.focus');
        return;
      case 'search':
        if (typeof message.query === 'string') {
          this.query = message.query.slice(0, 200);
          await this.postState();
        }
        return;
      case 'jump':
        if (typeof message.id === 'string') {
          await this.jumpToSymbol(message.id);
        }
        return;
      case 'toggleFollow':
        await this.refreshSymbols('固定模式已移除');
        return;
      case 'preference':
        if (typeof message.key === 'string') {
          await this.updatePreference(message.key, message.value);
        }
        return;
      case 'openLanguageExtensions':
        if (!(await hasVscodeCommand('workbench.extensions.search'))) {
          await vscode.window.showInformationMessage('当前 VS Code 无法自动打开语言扩展搜索，请手动打开扩展视图并搜索对应语言支持。');
          return;
        }
        await vscode.commands.executeCommand('workbench.extensions.search', `@category:"Programming Languages"`);
        return;
      case 'manageExclusions':
        await vscode.commands.executeCommand('projectManager.manageExclusions');
        await this.refreshSymbols('调整屏蔽规则');
        return;
      case 'focusNativeOutline':
        await focusNativeOutlineView();
        return;
      case 'useBothOutlines':
        await this.applyMode('both', false);
        return;
      case 'toggleNativeOutlineNotice':
        if (typeof message.expanded === 'boolean') {
          await this.context.workspaceState.update(NATIVE_NOTICE_EXPANDED_KEY, message.expanded);
          await this.postState();
        }
        return;
      default:
        return;
    }
  }

  private async toggleFollow(): Promise<void> {
    await vscode.window.showInformationMessage('函数大纲现在始终跟随当前活动文本文件，固定模式已移除。');
    return;
    /* 旧版固定状态处理代码保留用于兼容历史安装数据，但不再进入。 */
    const next = !this.preferences.followActiveEditor;
    if (!next) {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined && this.targetUri === undefined) {
        await vscode.window.showInformationMessage('请先打开一个源码文件，再固定函数大纲。');
        return;
      }
      this.targetUri = editor?.document.uri ?? this.targetUri;
      await this.context.workspaceState.update(PINNED_URI_KEY, this.targetUri?.toString());
    } else {
      await this.context.workspaceState.update(PINNED_URI_KEY, undefined);
      const editor = vscode.window.activeTextEditor;
      this.targetUri = editor?.document.uri;
      this.sourceViewColumn = editor?.viewColumn;
    }

    await vscode.workspace.getConfiguration('projectManager.symbolOutline')
      .update('followActiveEditor', next, vscode.ConfigurationTarget.Global);
  }

  private async updatePreference(key: string, value: unknown): Promise<void> {
    const allowed: Record<string, readonly unknown[]> = {
      scope: ['functions', 'functionsAndTypes', 'all'],
      hierarchy: ['tree', 'flat'],
      sort: ['source', 'name', 'typeName'],
      appearance: ['vscode', 'sourceInsightLight', 'sourceInsightBlack'],
      showLineMetrics: [true, false],
      highlightLongFunctions: [true, false],
      highlightEditedSymbols: [true, false],
    };

    if (key === 'mode' && typeof value === 'string' && ['native', 'enhanced', 'both'].includes(value)) {
      await this.applyMode(value as OutlineMode, true);
      return;
    }

    if (key === 'scale' && typeof value === 'number' && Number.isFinite(value)) {
      await vscode.workspace.getConfiguration('projectManager.symbolOutline')
        .update(key, clamp(Math.round(value), 90, 150), vscode.ConfigurationTarget.Global);
      return;
    }
    if (!(key in allowed) || !allowed[key]?.includes(value)) {
      return;
    }
    await vscode.workspace.getConfiguration('projectManager.symbolOutline')
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  private async applyMode(mode: OutlineMode, showEnhancedHint: boolean): Promise<void> {
    const previousMode = this.preferences.mode;
    await updateOutlineMode(mode, this.catalogService);
    const effectiveMode = this.preferences.mode;
    if (effectiveMode !== previousMode) {
      this.lastMode = effectiveMode;
    }
    if (effectiveMode === 'native') {
      await focusNativeOutlineView();
      return;
    }
    if (effectiveMode === 'enhanced' && showEnhancedHint) {
      await this.postState();
    }
  }

  private async jumpToSymbol(id: string): Promise<void> {
    const symbol = flattenSymbols(this.currentSymbols).find((item) => item.id === id);
    const uri = this.targetUri;
    if (symbol === undefined || uri === undefined) {
      return;
    }

    const document = await this.getDocument(uri);
    const activeEditor = vscode.window.activeTextEditor;
    let editor: vscode.TextEditor;
    if (activeEditor !== undefined && activeEditor.document.uri.toString() === uri.toString()) {
      editor = activeEditor;
    } else {
      const options: vscode.TextDocumentShowOptions = {
        preserveFocus: false,
        preview: true,
      };
      if (this.sourceViewColumn !== undefined) {
        options.viewColumn = this.sourceViewColumn;
      }
      editor = await vscode.window.showTextDocument(document, options);
    }
    const start = toVsCodePosition(symbol.selectionRange.start);
    const focusedEditor = await vscode.window.showTextDocument(document, {
      ...(editor.viewColumn === undefined ? {} : { viewColumn: editor.viewColumn }),
      preserveFocus: false,
      preview: true,
    });
    const selectionRange = toVsCodeRange(symbol.selectionRange);
    focusedEditor.selection = selectionRange.isEmpty
      ? new vscode.Selection(start, start)
      : new vscode.Selection(selectionRange.start, selectionRange.end);
    focusedEditor.revealRange(
      selectionRange.isEmpty ? new vscode.Range(start, start) : selectionRange,
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
    this.showJumpHighlight(focusedEditor, symbol.selectionRange.start.line);
  }

  private showJumpHighlight(editor: vscode.TextEditor, line: number): void {
    if (this.jumpHighlightTimer !== undefined) {
      clearTimeout(this.jumpHighlightTimer);
    }
    this.jumpHighlightEditor?.setDecorations(this.jumpHighlightDecoration, []);
    const safeLine = Math.max(0, Math.min(line, editor.document.lineCount - 1));
    const range = new vscode.Range(safeLine, 0, safeLine, 0);
    editor.setDecorations(this.jumpHighlightDecoration, [range]);
    this.jumpHighlightEditor = editor;
    this.jumpHighlightTimer = setTimeout(() => {
      editor.setDecorations(this.jumpHighlightDecoration, []);
      if (this.jumpHighlightEditor === editor) {
        this.jumpHighlightEditor = undefined;
      }
      this.jumpHighlightTimer = undefined;
    }, 1_200);
  }

  private setStatus(status: OutlineStatus, message: string): void {
    this.status = status;
    this.statusMessage = message;
  }

  private async postState(document?: vscode.TextDocument): Promise<void> {
    const view = this.view;
    if (view === undefined) {
      return;
    }
    const webview = view.webview;

    const state = this.createState(document);
    view.description = '当前活动文件';
    await webview.postMessage({ type: 'state', state });
  }

  private createState(document?: vscode.TextDocument): OutlineViewState {
    const actualDocument = document ?? (this.targetUri === undefined
      ? undefined
      : vscode.workspace.textDocuments.find((item) => item.uri.toString() === this.targetUri?.toString()));
    const preferences = this.preferences;
    const symbols = projectSymbols(this.currentSymbols, {
      scope: preferences.scope,
      hierarchy: preferences.hierarchy,
      sort: preferences.sort,
      query: this.query,
      locale: vscode.env.language,
    });
    const editor = vscode.window.activeTextEditor;
    const current = editor !== undefined && editor.document.uri.toString() === this.targetUri?.toString()
      ? findCurrentSymbol(this.currentSymbols, editor.selection.active)
      : undefined;
    const uri = this.targetUri;
    const filePath = uri === undefined
      ? ''
      : vscode.workspace.getWorkspaceFolder(uri) === undefined
        ? uri.scheme === 'file' ? uri.fsPath : uri.toString(true)
        : vscode.workspace.asRelativePath(uri, false);
    return {
      status: this.status,
      message: this.statusMessage,
      fileName: actualDocument === undefined ? uri === undefined ? '' : path.basename(uri.path) : path.basename(actualDocument.fileName),
      filePath,
      languageId: actualDocument?.languageId ?? '',
      external: uri !== undefined && vscode.workspace.getWorkspaceFolder(uri) === undefined,
      dirty: actualDocument?.isDirty ?? false,
      following: preferences.followActiveEditor,
      query: this.query,
      currentId: current?.id ?? '',
      totalCount: countSymbols(this.currentSymbols),
      visibleCount: countSymbols(symbols),
      symbols,
      preferences,
      nativeOutlineNotice: isNativeOutlineNoticeVisible(preferences.mode),
      nativeOutlineNoticeExpanded: this.context.workspaceState.get<boolean>(NATIVE_NOTICE_EXPANDED_KEY, true),
    };
  }

  private withEditedState(symbols: readonly OutlineSymbol[], documentKey: string): OutlineSymbol[] {
    const edited = this.editedByDocument.get(documentKey) ?? new Set<string>();
    const visit = (symbol: OutlineSymbol): OutlineSymbol => ({
      ...symbol,
      isEdited: edited.has(symbol.editKey),
      children: symbol.children.map(visit),
    });
    return symbols.map(visit);
  }

  private rememberCache(key: string, value: CachedSymbols): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > MAX_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
  }
}

class LegacyOutlineMigrationViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly messageSubscription: vscode.Disposable[] = [];

  public constructor(private readonly catalogService: ProjectFeatureConfigurationSource) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    webviewView.description = '已迁移到插件侧栏';
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { padding: 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    .notice { padding: 12px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-textBlockQuote-background); }
    button { margin-top: 10px; padding: 5px 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="notice">
    <strong>增强函数大纲已迁移</strong>
    <p>完整大纲现在位于“项目管家”插件侧栏。此资源管理器视图仅用于帮助已有用户找到新位置。</p>
    <button id="open">打开项目管家中的增强大纲</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'open' }));
  </script>
</body>
</html>`;
    this.messageSubscription.push(webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (isRecord(message) && message.type === 'open') {
        void showEnhancedOutlineView(this.catalogService);
      }
    }));
  }

  public dispose(): void {
    this.messageSubscription.splice(0).forEach((subscription) => subscription.dispose());
  }
}

export function registerSymbolOutline(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  catalogService: ProjectFeatureConfigurationSource,
): SymbolOutlineViewProvider {
  const provider = new SymbolOutlineViewProvider(context, output, catalogService);
  const legacyProvider = new LegacyOutlineMigrationViewProvider(catalogService);
  const updateModeContext = (): void => {
    const enabled = isEnhancedOutlineEnabled(getOutlineMode(catalogService));
    void vscode.commands.executeCommand('setContext', 'projectManager.symbolOutlineEnhancedEnabled', enabled);
  };
  context.subscriptions.push(
    provider,
    legacyProvider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(LEGACY_VIEW_ID, legacyProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    catalogService.onDidChange(updateModeContext),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('projectManager.symbolOutline.mode')) {
        updateModeContext();
      }
    }),
    vscode.commands.registerCommand('projectManager.refreshSymbolOutline', async () => {
      await provider.refreshSymbols('命令刷新');
    }),
    vscode.commands.registerCommand('projectManager.selectSymbolOutlineAppearance', async () => {
      await provider.selectAppearance();
    }),
    vscode.commands.registerCommand('projectManager.selectSymbolOutlineMode', async () => {
      await provider.selectMode();
    }),
    vscode.commands.registerCommand('projectManager.showSymbolOutline', async () => {
      await showEnhancedOutlineView(catalogService);
    }),
    vscode.commands.registerCommand('projectManager.openNativeOutline', async () => {
      await openNativeOutlineWithModeCheck(catalogService);
    }),
    vscode.commands.registerCommand('projectManager.resolveNativeOutlineConflict', async () => {
      await resolveVisibleNativeOutlineConflict(catalogService);
    }),
  );
  updateModeContext();
  void showLocationHintOnce(context, catalogService);
  return provider;
}

async function updateOutlineMode(mode: OutlineMode, catalogService: ProjectFeatureConfigurationSource): Promise<void> {
  const updatedCatalog = await catalogService.updateCurrentOutlineMode(mode);
  if (!updatedCatalog) {
    await vscode.workspace.getConfiguration('projectManager.symbolOutline')
      .update('mode', mode, vscode.ConfigurationTarget.Global);
  }
  const effectiveMode = getOutlineMode(catalogService);
  await vscode.commands.executeCommand(
    'setContext',
    'projectManager.symbolOutlineEnhancedEnabled',
    isEnhancedOutlineEnabled(effectiveMode),
  );
}

function getOutlineMode(catalogService: ProjectFeatureConfigurationSource): OutlineMode {
  return resolveEffectiveOutlineMode(catalogService.currentProjectSymbolOutlineSettings).mode;
}

async function resolveVisibleNativeOutlineConflict(catalogService: ProjectFeatureConfigurationSource): Promise<OutlineMode> {
  const selected = await vscode.window.showWarningMessage(
    '当前配置为“仅使用增强大纲”，但 VS Code 原生大纲已经打开。请选择新的大纲模式；关闭此提示将自动改为“仅使用原生大纲”。',
    { modal: true },
    '同时使用',
    '只使用原生',
  );
  const nextMode = resolveNativeOutlineConflict(selected === '同时使用' ? 'both' : selected === '只使用原生' ? 'native' : undefined);
  await updateOutlineMode(nextMode, catalogService);
  if (nextMode === 'native') {
    await focusNativeOutlineView();
  }
  return nextMode;
}

async function openNativeOutlineWithModeCheck(catalogService: ProjectFeatureConfigurationSource): Promise<void> {
  if (getOutlineMode(catalogService) === 'enhanced') {
    await resolveVisibleNativeOutlineConflict(catalogService);
  }
  await focusNativeOutlineView();
}

async function showEnhancedOutlineView(catalogService: ProjectFeatureConfigurationSource): Promise<void> {
  let mode = getOutlineMode(catalogService);
  if (!isEnhancedOutlineEnabled(mode)) {
    const selected = await vscode.window.showInformationMessage(
      '当前配置为“仅使用 VS Code 原生大纲”。要如何打开增强函数大纲？',
      '只使用增强大纲',
      '同时使用',
    );
    if (selected === undefined) {
      return;
    }
    mode = selected === '只使用增强大纲' ? 'enhanced' : 'both';
    await updateOutlineMode(mode, catalogService);
  }
  await focusEnhancedOutlineView();
}

async function focusEnhancedOutlineView(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  } catch (error) {
    await vscode.window.showInformationMessage('无法自动定位增强函数大纲，请打开“项目管家”插件侧栏后选择“增强函数大纲”。');
  }
}

async function focusNativeOutlineView(): Promise<void> {
  if (!(await hasVscodeCommand('outline.focus'))) {
    await vscode.window.showInformationMessage('当前 VS Code 无法自动定位原生大纲，请在资源管理器的“视图”菜单中手动勾选“大纲”。');
    return;
  }
  try {
    await vscode.commands.executeCommand('outline.focus');
  } catch (error) {
    await vscode.window.showInformationMessage('无法自动定位 VS Code 原生大纲，请在资源管理器的“视图”菜单中勾选“大纲”。');
  }
}

async function showLocationHintOnce(
  context: vscode.ExtensionContext,
  catalogService: ProjectFeatureConfigurationSource,
): Promise<void> {
  if (context.globalState.get<boolean>(LOCATION_HINT_KEY, false)) {
    return;
  }
  await context.globalState.update(LOCATION_HINT_KEY, true);
  if (isEnhancedOutlineEnabled(getOutlineMode(catalogService))) {
    await focusEnhancedOutlineView();
  }
  const selected = await vscode.window.showInformationMessage(
    '增强函数大纲现在位于“项目管家”插件侧栏并已自动展开。也可以右键大纲标题，将它移动到右侧“辅助侧栏”。',
    '打开增强大纲',
    '查看移动方法',
  );
  if (selected === '打开增强大纲') {
    await showEnhancedOutlineView(catalogService);
    return;
  }
  if (selected === '查看移动方法') {
    await vscode.window.showInformationMessage(
      '先执行“视图: 切换辅助侧栏可见性”，再打开“项目管家”侧栏，右键“增强函数大纲”标题，选择“移动视图”→“辅助侧栏”。以后执行“项目管家: 打开/定位增强函数大纲”只会聚焦这一份大纲。',
      { modal: true },
    );
  }
}

function normalizeSymbols(
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  documentKey: string,
): OutlineSymbol[] {
  const normalizeDocumentSymbol = (symbol: vscode.DocumentSymbol, parentPath: string): OutlineSymbol => {
    const kind = symbolKindName(symbol.kind);
    const displayName = getOutlineDisplayName(symbol.name, kind);
    const currentPath = parentPath.length === 0 ? displayName : `${parentPath} › ${displayName}`;
    return {
      id: createSymbolId(documentKey, kind, displayName, parentPath, fromVsCodePosition(symbol.selectionRange.start)),
      editKey: createEditKey(kind, displayName, parentPath),
      name: displayName,
      detail: symbol.detail,
      containerName: parentPath,
      parentPath,
      kind,
      range: fromVsCodeRange(symbol.range),
      selectionRange: fromVsCodeRange(symbol.selectionRange),
      span: Math.max(1, symbol.range.end.line - symbol.range.start.line + 1),
      isLong: false,
      isEdited: false,
      isContext: false,
      children: symbol.children.map((child) => normalizeDocumentSymbol(child, currentPath)),
    };
  };

  return symbols.map((symbol) => {
    if (isDocumentSymbol(symbol)) {
      return normalizeDocumentSymbol(symbol, '');
    }
    const kind = symbolKindName(symbol.kind);
    const displayName = getOutlineDisplayName(symbol.name, kind);
    const range = fromVsCodeRange(symbol.location.range);
    const parentPath = symbol.containerName;
    return {
      id: createSymbolId(documentKey, kind, displayName, parentPath, range.start),
      editKey: createEditKey(kind, displayName, parentPath),
      name: displayName,
      detail: '',
      containerName: symbol.containerName,
      parentPath,
      kind,
      range,
      selectionRange: range,
      span: Math.max(1, range.end.line - range.start.line + 1),
      isLong: false,
      isEdited: false,
      isContext: false,
      children: [],
    };
  });
}

function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
): symbol is vscode.DocumentSymbol {
  return 'range' in symbol && 'selectionRange' in symbol;
}

function symbolKindName(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] ?? 'Unknown';
}

function fromVsCodePosition(position: vscode.Position): { line: number; character: number } {
  return { line: position.line, character: position.character };
}

function fromVsCodeRange(range: vscode.Range): OutlineRange {
  return { start: fromVsCodePosition(range.start), end: fromVsCodePosition(range.end) };
}

function findMatchingFilesExclude(document: vscode.TextDocument): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder === undefined) {
    return undefined;
  }
  const excludes = vscode.workspace
    .getConfiguration('files', document.uri)
    .get<Readonly<Record<string, boolean | { readonly when: string }>>>('exclude', {});

  for (const [pattern, value] of Object.entries(excludes)) {
    if (value !== true || pattern.trim().length === 0) {
      continue;
    }
    const normalized = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
    const candidates = new Set<string>([normalized]);
    if (!normalized.endsWith('/**')) {
      candidates.add(`${normalized}/**`);
    }
    if (!normalized.includes('/')) {
      candidates.add(`**/${normalized}`);
      candidates.add(`**/${normalized}/**`);
    }
    if ([...candidates].some((candidate) => vscode.languages.match({
      scheme: document.uri.scheme,
      pattern: new vscode.RelativePattern(folder, candidate),
    }, document) > 0)) {
      return pattern;
    }
  }
  return undefined;
}

function toVsCodePosition(position: { line: number; character: number }): vscode.Position {
  return new vscode.Position(position.line, position.character);
}

function toVsCodeRange(range: OutlineRange): vscode.Range {
  return new vscode.Range(toVsCodePosition(range.start), toVsCodePosition(range.end));
}

function readEnum<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return value !== undefined && allowed.includes(value as T) ? value as T : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
