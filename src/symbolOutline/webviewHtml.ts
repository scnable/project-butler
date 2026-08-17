import * as vscode from 'vscode';
import {
  getSymbolIconMetadata,
  IconSemantic,
  STANDARD_SYMBOL_KIND_NAMES,
  SYNTHETIC_SYMBOL_KIND_NAMES,
} from '../visual/iconSemantics';
import { createWebviewIconResourceMap } from '../visual/webviewIconResources';

export function getSymbolOutlineHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const nonce = createNonce();
  const symbolKinds = Object.fromEntries([
    ...STANDARD_SYMBOL_KIND_NAMES,
    ...SYNTHETIC_SYMBOL_KIND_NAMES,
    'Unknown',
  ].map((kind) => {
    const metadata = getSymbolIconMetadata(kind);
    return [kind, { label: metadata.label, semantic: metadata.semantic }];
  }));
  const iconSemantics: IconSemantic[] = [
    ...Object.values(symbolKinds).map((metadata) => metadata.semantic),
    'state.warning',
    'state.edited',
    'state.long-function',
  ];
  const iconResources = createWebviewIconResourceMap(webview, extensionUri, iconSemantics);
  const iconResourceCss = createIconResourceCss(iconResources);
  const monochromeIcons = Object.fromEntries(
    Object.entries(iconResources).map(([semantic, resources]) => [semantic, resources.monochromeOnly]),
  );
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root {
      --outline-bg: var(--vscode-sideBar-background);
      --outline-fg: var(--vscode-sideBar-foreground);
      --outline-muted: var(--vscode-descriptionForeground);
      --outline-selection: var(--vscode-list-activeSelectionBackground);
      --outline-selection-fg: var(--vscode-list-activeSelectionForeground);
      --outline-current: var(--vscode-focusBorder);
      --outline-border: var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      --outline-edited: var(--vscode-gitDecoration-modifiedResourceForeground, #c05a00);
      --outline-long: var(--vscode-editorWarning-foreground, #8a5a00);
      --outline-ui-font: var(--vscode-font-family);
      --outline-code-font: var(--vscode-editor-font-family);
      --outline-scale: 1;
    }
    body[data-appearance="sourceInsightLight"] {
      --outline-bg: #f2f2f2;
      --outline-fg: #202020;
      --outline-muted: #666666;
      --outline-selection: #cce8ff;
      --outline-selection-fg: #202020;
      --outline-current: #0078d4;
      --outline-border: #d0d0d0;
      --outline-edited: #c05a00;
      --outline-long: #8a5a00;
      --outline-ui-font: "Segoe UI", Tahoma, sans-serif;
      --outline-code-font: Consolas, "Courier New", monospace;
    }
    body[data-appearance="sourceInsightBlack"] {
      --outline-bg: #1e1e1e;
      --outline-fg: #dcdcdc;
      --outline-muted: #9d9d9d;
      --outline-selection: #264f78;
      --outline-selection-fg: #ffffff;
      --outline-current: #4fc1ff;
      --outline-border: #3a3a3a;
      --outline-edited: #ffb454;
      --outline-long: #d7ba7d;
      --outline-ui-font: "Segoe UI", Tahoma, sans-serif;
      --outline-code-font: Consolas, "Courier New", monospace;
    }
    body.vscode-high-contrast, body.vscode-high-contrast-light {
      --outline-bg: var(--vscode-sideBar-background);
      --outline-fg: var(--vscode-sideBar-foreground);
      --outline-muted: var(--vscode-descriptionForeground);
      --outline-selection: var(--vscode-list-activeSelectionBackground);
      --outline-selection-fg: var(--vscode-list-activeSelectionForeground);
      --outline-current: var(--vscode-focusBorder);
      --outline-border: var(--vscode-contrastBorder);
      --outline-edited: var(--vscode-gitDecoration-modifiedResourceForeground);
      --outline-long: var(--vscode-editorWarning-foreground);
      --outline-ui-font: var(--vscode-font-family);
      --outline-code-font: var(--vscode-editor-font-family);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      color: var(--outline-fg);
      background: var(--outline-bg);
      font-family: var(--outline-ui-font);
      font-size: calc(12px * var(--outline-scale));
      overflow: hidden;
    }
    button, input, select { font: inherit; }
    .shell { display: flex; flex-direction: column; height: 100vh; min-height: 0; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      padding: 5px 6px;
      border-bottom: 1px solid var(--outline-border);
    }
    .toolbar button, .toolbar select, .toolbar input, details button {
      min-height: 24px;
      color: var(--outline-fg);
      background: var(--vscode-input-background, transparent);
      border: 1px solid var(--vscode-input-border, var(--outline-border));
      border-radius: 2px;
    }
    .toolbar button { padding: 2px 7px; cursor: pointer; }
    .toolbar button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .toolbar button:focus-visible, .toolbar select:focus-visible, .toolbar input:focus-visible,
    summary:focus-visible, .symbol-row:focus-visible, .caret:focus-visible {
      outline: 1px solid var(--outline-current);
      outline-offset: -1px;
    }
    .search { flex: 1 1 120px; min-width: 80px; padding: 2px 6px; }
    .search::placeholder { color: var(--outline-muted); }
    .appearance-quick { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
    .appearance-quick select { max-width: 150px; }
    .mode-notice {
      padding: 8px;
      color: var(--vscode-notifications-foreground, var(--outline-fg));
      background: var(--vscode-inputValidation-warningBackground, #cca70022);
      border-bottom: 1px solid var(--outline-border);
      line-height: 1.45;
    }
    .mode-notice-title { font-weight: 700; }
    .mode-notice-summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 600; }
    .mode-notice-summary[hidden], .mode-notice-details[hidden] { display: none; }
    .mode-notice-text { margin: 3px 0 7px; color: var(--outline-muted); }
    .mode-notice-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .mode-notice button {
      min-height: 24px;
      padding: 2px 8px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 2px;
      cursor: pointer;
    }
    .mode-notice button:hover { background: var(--vscode-button-hoverBackground); }
    .mode-notice button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .mode-notice button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .file-status { padding: 5px 8px; border-bottom: 1px solid var(--outline-border); min-width: 0; }
    .file-name { display: flex; align-items: center; gap: 5px; font-weight: 600; }
    .file-name-text, .file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-path { margin-top: 2px; color: var(--outline-muted); font-size: 0.92em; }
    .file-badge { margin: 0 1px 0 0; color: var(--outline-edited); }
    .list-wrap { flex: 1; min-height: 0; overflow: auto; padding: 3px 0 8px; }
    .message { padding: 14px 12px; color: var(--outline-muted); line-height: 1.5; }
    .message button { margin-top: 8px; color: var(--vscode-textLink-foreground); background: none; border: 0; padding: 0; cursor: pointer; }
    .count { padding: 3px 8px; color: var(--outline-muted); font-size: 0.9em; }
    .symbol-row {
      display: flex;
      align-items: center;
      height: calc(22px * var(--outline-scale));
      min-width: 0;
      width: 100%;
      padding-right: 6px;
      box-sizing: border-box;
      border-left: 2px solid transparent;
      cursor: default;
      user-select: none;
    }
    .symbol-row:hover { background: var(--vscode-list-hoverBackground); }
    .symbol-row.current {
      color: var(--outline-selection-fg);
      background: var(--outline-selection);
      border-left-color: var(--outline-current);
    }
    .symbol-row.context { opacity: 0.8; }
    .caret { flex: 0 0 18px; width: 18px; height: 18px; padding: 0; border: 0; color: inherit; background: none; cursor: pointer; }
    .caret.empty { visibility: hidden; }
    .kind-icon {
      display: inline-block;
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      margin-right: 4px;
      color: var(--vscode-symbolIcon-functionForeground, var(--outline-current));
      background-position: center;
      background-repeat: no-repeat;
      background-size: contain;
      -webkit-mask-position: center;
      -webkit-mask-repeat: no-repeat;
      -webkit-mask-size: contain;
      mask-position: center;
      mask-repeat: no-repeat;
      mask-size: contain;
    }
    .symbol-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .symbol-row.type .symbol-name, .symbol-row.long .symbol-name { font-weight: 600; }
    .metrics { flex: 0 0 auto; margin-left: auto; padding-left: 8px; color: var(--outline-muted); font-family: var(--outline-code-font); font-size: 0.88em; }
    .state-icon {
      display: inline-block;
      flex: 0 0 auto;
      width: 8px;
      height: 8px;
      margin-left: 4px;
      background-position: center;
      background-repeat: no-repeat;
      background-size: contain;
      -webkit-mask-position: center;
      -webkit-mask-repeat: no-repeat;
      -webkit-mask-size: contain;
      mask-position: center;
      mask-repeat: no-repeat;
      mask-size: contain;
    }
    .state-icon.edited { color: var(--outline-edited); }
    .state-icon.long { color: var(--outline-long); }
    .file-badge.state-icon { margin: 0 1px 0 0; }
    [data-icon-semantic] {
      background-image: var(--icon-light);
      -webkit-mask-image: none;
      mask-image: none;
    }
    body.vscode-dark [data-icon-semantic],
    body[data-appearance="sourceInsightBlack"] [data-icon-semantic] {
      background-image: var(--icon-dark);
    }
    body.vscode-light [data-icon-semantic],
    body[data-appearance="sourceInsightLight"] [data-icon-semantic] {
      background-image: var(--icon-light);
    }
    body.vscode-high-contrast [data-icon-semantic],
    body.vscode-high-contrast-light [data-icon-semantic],
    body[data-appearance] [data-icon-rendering="mask"] {
      background-color: currentColor;
      background-image: none;
      -webkit-mask-image: var(--icon-monochrome);
      mask-image: var(--icon-monochrome);
    }
    ${iconResourceCss}
    mark { color: inherit; background: var(--vscode-editor-findMatchHighlightBackground, #ea5c0055); border-radius: 2px; }
    details { position: relative; }
    summary { min-height: 24px; padding: 4px 7px; border: 1px solid var(--vscode-input-border, var(--outline-border)); border-radius: 2px; cursor: pointer; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    .more-panel {
      position: absolute;
      z-index: 10;
      right: 0;
      top: 28px;
      width: 230px;
      padding: 8px;
      color: var(--outline-fg);
      background: var(--outline-bg);
      border: 1px solid var(--outline-border);
      box-shadow: 0 3px 10px #0005;
    }
    .more-panel label { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
    .more-panel select, .more-panel input[type="range"] { flex: 1; min-width: 0; }
    .scale-value { width: 38px; text-align: right; color: var(--outline-muted); }
  </style>
</head>
<body data-appearance="vscode">
  <main class="shell">
    <section class="toolbar" aria-label="函数大纲工具栏">
      <select id="scope" title="符号范围" aria-label="符号范围">
        <option value="functions">仅函数</option>
        <option value="functionsAndTypes">函数与类型</option>
        <option value="all">全部符号</option>
      </select>
      <select id="sort" title="排序方式" aria-label="排序方式">
        <option value="source">源码顺序</option>
        <option value="name">按名称</option>
        <option value="typeName">类型+名称</option>
      </select>
      <button id="openOutlineSettings" type="button" title="打开函数大纲设置">设置</button>
      <button id="refresh" type="button" title="刷新符号">↻</button>
      <input id="search" class="search" type="search" maxlength="200" placeholder="搜索当前文件符号" aria-label="搜索当前文件符号">
    </section>
    <section id="modeNotice" class="mode-notice" aria-live="polite" hidden>
      <div id="modeNoticeSummary" class="mode-notice-summary" hidden>
        <span>仅增强模式已开启，原生大纲需手动隐藏</span>
        <button id="expandNativeOutlineNotice" class="secondary" type="button">详情</button>
      </div>
      <div id="modeNoticeDetails" class="mode-notice-details">
        <div class="mode-notice-title">仅增强模式已开启</div>
        <div class="mode-notice-text">VS Code 不允许插件自动隐藏或检测原生大纲是否已隐藏。请在资源管理器标题栏的“…”→“视图”中取消勾选“大纲”。</div>
        <div class="mode-notice-actions">
          <button id="focusNativeOutline" type="button">定位原生大纲</button>
          <button id="useBothOutlines" class="secondary" type="button">改为同时使用</button>
          <button id="collapseNativeOutlineNotice" class="secondary" type="button">折叠</button>
        </div>
      </div>
    </section>
    <section id="fileStatus" class="file-status" hidden>
      <div class="file-name"><span id="fileBadge" class="file-badge state-icon" data-icon-semantic="state.warning" data-icon-rendering="mask" hidden></span><span id="fileName" class="file-name-text"></span></div>
      <div id="filePath" class="file-path"></div>
    </section>
    <section id="listWrap" class="list-wrap" aria-live="polite"></section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const symbolKinds = ${serializeForScript(symbolKinds)};
    const monochromeIcons = ${serializeForScript(monochromeIcons)};
    const elements = {
      scope: document.getElementById('scope'), sort: document.getElementById('sort'),
      openOutlineSettings: document.getElementById('openOutlineSettings'),
      refresh: document.getElementById('refresh'), search: document.getElementById('search'),
      fileStatus: document.getElementById('fileStatus'),
      modeNotice: document.getElementById('modeNotice'),
      modeNoticeSummary: document.getElementById('modeNoticeSummary'),
      modeNoticeDetails: document.getElementById('modeNoticeDetails'),
      focusNativeOutline: document.getElementById('focusNativeOutline'),
      useBothOutlines: document.getElementById('useBothOutlines'),
      expandNativeOutlineNotice: document.getElementById('expandNativeOutlineNotice'),
      collapseNativeOutlineNotice: document.getElementById('collapseNativeOutlineNotice'),
      fileBadge: document.getElementById('fileBadge'), fileName: document.getElementById('fileName'),
      filePath: document.getElementById('filePath'), listWrap: document.getElementById('listWrap')
    };
    const collapsed = new Set();
    let currentState;
    let previousCurrentId = '';
    let searchTimer;

    elements.refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    elements.openOutlineSettings.addEventListener('click', () => vscode.postMessage({ type: 'openOutlineSettings' }));
    elements.focusNativeOutline.addEventListener('click', () => vscode.postMessage({ type: 'focusNativeOutline' }));
    elements.useBothOutlines.addEventListener('click', () => vscode.postMessage({ type: 'useBothOutlines' }));
    elements.expandNativeOutlineNotice.addEventListener('click', () => vscode.postMessage({ type: 'toggleNativeOutlineNotice', expanded: true }));
    elements.collapseNativeOutlineNotice.addEventListener('click', () => vscode.postMessage({ type: 'toggleNativeOutlineNotice', expanded: false }));
    elements.search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => vscode.postMessage({ type: 'search', query: elements.search.value }), 80);
    });
    ['scope', 'sort'].forEach((key) => {
      elements[key].addEventListener('change', () => vscode.postMessage({ type: 'preference', key, value: elements[key].value }));
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'state') renderState(message.state);
      if (message.type === 'current') updateCurrent(message.currentId || '');
    });

    function renderState(state) {
      if (!state) return;
      currentState = state;
      document.body.dataset.appearance = state.preferences.appearance;
      document.documentElement.style.setProperty('--outline-scale', String(state.preferences.scale / 100));
      elements.modeNotice.hidden = !state.nativeOutlineNotice;
      elements.modeNoticeSummary.hidden = state.nativeOutlineNoticeExpanded;
      elements.modeNoticeDetails.hidden = !state.nativeOutlineNoticeExpanded;
      elements.scope.value = state.preferences.scope;
      elements.sort.value = state.preferences.sort;
      if (document.activeElement !== elements.search) elements.search.value = state.query;

      elements.fileStatus.hidden = !state.fileName;
      elements.fileName.textContent = state.fileName + (state.dirty ? ' • 未保存' : '');
      elements.filePath.textContent = state.filePath;
      elements.fileBadge.hidden = !state.external;
      elements.fileBadge.title = state.external ? '工作区外文件' : '';

      elements.listWrap.replaceChildren();
      if (state.status !== 'ready') {
        const action = state.status === 'unsupported'
          ? 'extensions'
          : state.status === 'excluded'
            ? 'exclusions'
            : '';
        renderMessage(state.message, action);
        return;
      }
      const count = document.createElement('div');
      count.className = 'count';
      count.textContent = state.visibleCount === state.totalCount
        ? String(state.totalCount) + ' 个符号'
        : '显示 ' + String(state.visibleCount) + ' / ' + String(state.totalCount) + ' 个符号';
      elements.listWrap.appendChild(count);
      const tree = document.createElement('div');
      tree.setAttribute('role', 'tree');
      tree.setAttribute('aria-label', state.fileName + ' 的函数与符号');
      let rendered = 0;
      for (const symbol of state.symbols) rendered = renderSymbol(symbol, tree, 0, rendered);
      elements.listWrap.appendChild(tree);
      if (rendered >= 2000) renderMessage('符号超过 2,000 个，请使用类型过滤或搜索缩小结果。', '');
      updateCurrent(state.currentId || '');
    }

    function renderMessage(text, action) {
      const box = document.createElement('div');
      box.className = 'message';
      box.textContent = text || '';
      if (action) {
        const br = document.createElement('br');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = action === 'exclusions' ? '管理/取消屏蔽' : '查找语言扩展';
        button.addEventListener('click', () => vscode.postMessage({
          type: action === 'exclusions' ? 'manageExclusions' : 'openLanguageExtensions',
        }));
        box.append(br, button);
      }
      elements.listWrap.appendChild(box);
    }

    function renderSymbol(symbol, parent, depth, rendered) {
      if (rendered >= 2000) return rendered;
      rendered += 1;
      const group = document.createElement('div');
      group.setAttribute('role', 'none');
      const row = document.createElement('div');
      row.className = 'symbol-row' + (isType(symbol.kind) ? ' type' : '')
        + (symbol.isLong && currentState.preferences.highlightLongFunctions ? ' long' : '')
        + (symbol.isContext ? ' context' : '');
      row.dataset.id = symbol.id;
      row.dataset.parent = symbol.parentPath;
      row.style.paddingLeft = String(4 + depth * 13) + 'px';
      row.setAttribute('role', 'treeitem');
      row.setAttribute('tabindex', '-1');
      row.setAttribute('aria-level', String(depth + 1));
      const iconMetadata = symbolKindMetadata(symbol.kind);
      row.setAttribute('aria-label', iconMetadata.label + ' ' + symbol.name + '，第 ' + String(symbol.selectionRange.start.line + 1) + ' 行');

      const hasChildren = symbol.children.length > 0;
      const caret = document.createElement('button');
      caret.type = 'button';
      caret.className = 'caret' + (hasChildren ? '' : ' empty');
      caret.tabIndex = -1;
      const isCollapsed = collapsed.has(symbol.id);
      caret.textContent = isCollapsed ? '▸' : '▾';
      caret.setAttribute('aria-label', isCollapsed ? '展开' : '折叠');
      if (hasChildren) row.setAttribute('aria-expanded', String(!isCollapsed));

      const icon = createSemanticIcon(iconMetadata.semantic, 'kind-icon', iconMetadata.label);
      const name = document.createElement('span');
      name.className = 'symbol-name';
      name.title = symbol.name;
      appendHighlighted(name, symbol.name, currentState.query);
      row.append(caret, icon, name);
      if (currentState.preferences.showLineMetrics) {
        const metrics = document.createElement('span');
        metrics.className = 'metrics';
        metrics.textContent = 'L' + String(symbol.selectionRange.start.line + 1) + ' · ' + String(symbol.span) + '行';
        row.appendChild(metrics);
      }
      if (symbol.isEdited && currentState.preferences.highlightEditedSymbols) row.appendChild(stateIcon('state.edited', 'edited', '本次会话中尚未保存的编辑'));
      if (symbol.isLong && currentState.preferences.highlightLongFunctions) row.appendChild(stateIcon('state.long-function', 'long', '函数跨度高于当前文件平均值'));

      const children = document.createElement('div');
      children.setAttribute('role', 'group');
      children.hidden = isCollapsed;
      caret.addEventListener('click', (event) => {
        event.stopPropagation();
        const nextCollapsed = !children.hidden;
        children.hidden = nextCollapsed;
        caret.textContent = nextCollapsed ? '▸' : '▾';
        row.setAttribute('aria-expanded', String(!nextCollapsed));
        if (nextCollapsed) collapsed.add(symbol.id); else collapsed.delete(symbol.id);
      });
      row.addEventListener('click', () => vscode.postMessage({ type: 'jump', id: symbol.id }));
      row.addEventListener('keydown', (event) => handleTreeKey(event, row, caret, children, hasChildren));
      group.append(row, children);
      parent.appendChild(group);
      for (const child of symbol.children) rendered = renderSymbol(child, children, depth + 1, rendered);
      return rendered;
    }

    function handleTreeKey(event, row, caret, children, hasChildren) {
      const rows = Array.from(document.querySelectorAll('.symbol-row')).filter((item) => item.offsetParent !== null);
      const index = rows.indexOf(row);
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        row.click();
      } else if (event.key === 'ArrowDown' && index < rows.length - 1) {
        event.preventDefault(); rows[index + 1].focus();
      } else if (event.key === 'ArrowUp' && index > 0) {
        event.preventDefault(); rows[index - 1].focus();
      } else if (event.key === 'ArrowRight' && hasChildren && children.hidden) {
        event.preventDefault(); caret.click();
      } else if (event.key === 'ArrowLeft' && hasChildren && !children.hidden) {
        event.preventDefault(); caret.click();
      }
    }

    function updateCurrent(id) {
      document.querySelectorAll('.symbol-row.current').forEach((row) => {
        row.classList.remove('current'); row.removeAttribute('aria-current'); row.tabIndex = -1;
      });
      const row = Array.from(document.querySelectorAll('.symbol-row')).find((item) => item.dataset.id === id);
      if (row) {
        row.classList.add('current'); row.setAttribute('aria-current', 'true'); row.tabIndex = 0;
        if (id !== previousCurrentId) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
      } else {
        const first = document.querySelector('.symbol-row');
        if (first) first.tabIndex = 0;
      }
      previousCurrentId = id;
    }

    function appendHighlighted(target, value, query) {
      const needle = String(query || '').trim().toLocaleLowerCase();
      if (!needle) { target.textContent = value; return; }
      const lower = value.toLocaleLowerCase();
      let from = 0;
      while (from < value.length) {
        const index = lower.indexOf(needle, from);
        if (index < 0) { target.append(document.createTextNode(value.slice(from))); break; }
        if (index > from) target.append(document.createTextNode(value.slice(from, index)));
        const mark = document.createElement('mark');
        mark.textContent = value.slice(index, index + needle.length);
        target.append(mark);
        from = index + needle.length;
      }
    }

    function symbolKindMetadata(kind) {
      return symbolKinds[kind] || symbolKinds.Unknown;
    }
    function createSemanticIcon(semantic, className, title) {
      const icon = document.createElement('span');
      icon.className = className;
      icon.dataset.iconSemantic = semantic;
      if (monochromeIcons[semantic]) icon.dataset.iconRendering = 'mask';
      icon.title = title;
      icon.setAttribute('aria-hidden', 'true');
      return icon;
    }
    function stateIcon(semantic, className, title) {
      return createSemanticIcon(semantic, 'state-icon ' + className, title);
    }
    function isType(kind) { return ['Class','Interface','Struct','Namespace','Module','Enum','TypeParameter','PreprocessorRegion','PreprocessorBranch'].includes(kind); }
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function createIconResourceCss(
  resources: ReturnType<typeof createWebviewIconResourceMap>,
): string {
  return Object.entries(resources).map(([semantic, resource]) => `
    [data-icon-semantic="${semantic}"] {
      --icon-monochrome: url("${escapeCssUrl(resource.monochrome)}");
      --icon-light: url("${escapeCssUrl(resource.light)}");
      --icon-dark: url("${escapeCssUrl(resource.dark)}");
    }`).join('');
}

function escapeCssUrl(value: string): string {
  return value.replace(/["\\\n\r\f]/g, (character) => `\\${character}`);
}
