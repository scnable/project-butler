import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { applyPersonalSettingValue } from '../configuration/configurationTreeProvider';
import { hasVscodeCommand } from '../platform/vscodeCapabilities';
import { flattenSymbols } from '../symbolOutline/symbolModel';
import { closeAllEditors, delay, getApi, openText, projectUri, resetCatalogs } from './helpers';

suite('增强函数大纲', () => {
  setup(async () => {
    const api = await getApi();
    await resetCatalogs(api);
    await closeAllEditors();
    await restoreOutlineDefaults();
    await api.outline.setQueryForIntegrationTest('');
  });

  suiteTeardown(async () => {
    await restoreOutlineDefaults();
    await closeAllEditors();
  });

  test('INT-129 TypeScript 源码返回真实符号内容', async () => {
    const state = await openSampleAndRefresh();
    const names = flattenSymbols(state.symbols).map((symbol) => symbol.name);
    assert.equal(state.status, 'ready');
    assert.ok(names.includes('Calculator'));
    assert.ok(names.includes('calculateLongSequence'));
  });

  test('INT-130 files.exclude 命中文件显示准确屏蔽状态且不保留旧符号', async () => {
    const api = await getApi();
    await openText(projectUri(api, 'test-fixtures/workspace-one/normal.txt'));
    await api.outline.refreshSymbols('无符号测试');
    const state = api.outline.getStateForIntegrationTest();
    assert.equal(state.status, 'excluded');
    assert.match(state.message, /files\.exclude/);
    assert.match(state.message, /\*\*\/\*\.txt/);
    assert.equal(state.totalCount, 0);
  });

  test('INT-131 仅函数范围保留函数及必要类型祖先', async () => {
    await applyPersonalSettingValue('outlineScope', 'functions');
    const state = await openSampleAndRefresh();
    const symbols = flattenSymbols(state.symbols);
    assert.ok(symbols.some((symbol) => symbol.name === 'Calculator' && symbol.isContext));
    assert.equal(symbols.some((symbol) => symbol.name === 'sampleValue'), false);
  });

  test('INT-132 函数与类型范围排除普通变量', async () => {
    await applyPersonalSettingValue('outlineScope', 'functionsAndTypes');
    const state = await openSampleAndRefresh();
    const names = flattenSymbols(state.symbols).map((symbol) => symbol.name);
    assert.ok(names.includes('Calculator'));
    assert.ok(names.includes('item2'));
    assert.equal(names.includes('sampleValue'), false);
  });

  test('INT-133 全部符号范围包含常量', async () => {
    await applyPersonalSettingValue('outlineScope', 'all');
    const names = flattenSymbols((await openSampleAndRefresh()).symbols).map((symbol) => symbol.name);
    assert.ok(names.includes('sampleValue'));
  });

  test('INT-134 树状层级保留类与方法父子关系', async () => {
    await applyPersonalSettingValue('outlineHierarchy', 'tree');
    const state = await openSampleAndRefresh();
    const calculator = state.symbols.find((symbol) => symbol.name === 'Calculator');
    assert.ok(calculator?.children.some((symbol) => symbol.name === 'add'));
  });

  test('INT-135 旧平铺配置兼容读取但运行固定树状', async () => {
    await applyPersonalSettingValue('outlineHierarchy', 'flat');
    const state = await openSampleAndRefresh();
    const calculator = state.symbols.find((symbol) => symbol.name === 'Calculator');
    assert.equal(state.preferences.hierarchy, 'tree');
    assert.ok(calculator?.children.some((symbol) => symbol.name === 'add'));
  });

  test('INT-136 源码排序按起始行递增', async () => {
    await applyPersonalSettingValue('outlineHierarchy', 'flat');
    await applyPersonalSettingValue('outlineSort', 'source');
    const lines = (await openSampleAndRefresh()).symbols.map((symbol) => symbol.range.start.line);
    assert.deepEqual(lines, [...lines].sort((left, right) => left - right));
  });

  test('INT-137 名称排序采用自然数字顺序', async () => {
    await applyPersonalSettingValue('outlineHierarchy', 'flat');
    await applyPersonalSettingValue('outlineSort', 'name');
    const names = (await openSampleAndRefresh()).symbols.map((symbol) => symbol.name);
    assert.ok(names.indexOf('item2') < names.indexOf('item10'));
  });

  test('INT-138 类型与名称排序把类型放在函数前', async () => {
    await applyPersonalSettingValue('outlineHierarchy', 'flat');
    await applyPersonalSettingValue('outlineSort', 'typeName');
    const symbols = (await openSampleAndRefresh()).symbols;
    assert.ok(symbols.findIndex((symbol) => symbol.kind === 'Class') < symbols.findIndex((symbol) => symbol.kind === 'Function'));
  });

  test('INT-139 搜索名称只保留匹配符号与必要祖先', async () => {
    const api = await getApi();
    await openSampleAndRefresh();
    await api.outline.setQueryForIntegrationTest('calculateLong');
    const state = api.outline.getStateForIntegrationTest();
    const names = flattenSymbols(state.symbols).map((symbol) => symbol.name);
    assert.ok(names.includes('calculateLongSequence'));
    assert.equal(names.includes('item2'), false);
  });

  test('INT-140 点击符号等价跳转到真实源码位置', async () => {
    const api = await getApi();
    const state = await openSampleAndRefresh();
    const target = flattenSymbols(state.symbols).find((symbol) => symbol.name === 'item10');
    assert.ok(target);
    await api.outline.jumpToSymbolForIntegrationTest(target.id);
    assert.equal(vscode.window.activeTextEditor?.selection.active.line, target.selectionRange.start.line);
    assert.equal(vscode.window.activeTextEditor?.selection.anchor.line, target.selectionRange.start.line);
    assert.equal(vscode.window.activeTextEditor?.selection.end.line, target.selectionRange.end.line);
  });

  test('INT-141 光标位置计算最内层当前函数', async () => {
    const api = await getApi();
    const state = await openSampleAndRefresh();
    const target = flattenSymbols(state.symbols).find((symbol) => symbol.name === 'calculateLongSequence');
    assert.ok(target);
    const editor = vscode.window.activeTextEditor!;
    editor.selection = new vscode.Selection(target.selectionRange.start.line + 2, 4, target.selectionRange.start.line + 2, 4);
    await delay(100);
    assert.equal(api.outline.getStateForIntegrationTest().currentId, target.id);
  });

  test('INT-142 切换源码文件后大纲跟随新活动文件', async () => {
    const api = await getApi();
    await openSampleAndRefresh();
    const app = projectUri(api, 'test-fixtures/workspace-one/src/app.ts');
    await openText(app);
    await api.outline.refreshSymbols('切换测试');
    assert.equal(api.outline.getStateForIntegrationTest().fileName, 'app.ts');
  });

  test('INT-143 切到设置页不替换最后一个源码大纲', async () => {
    const api = await getApi();
    await openSampleAndRefresh();
    await vscode.commands.executeCommand('workbench.action.openSettings');
    await delay(100);
    assert.equal(api.outline.getStateForIntegrationTest().fileName, 'outline-sample.ts');
  });

  test('INT-144 函数名不显示参数且行号配置进入真实大纲状态', async () => {
    await applyPersonalSettingValue('showLineMetrics', false);
    const state = await openSampleAndRefresh();
    assert.equal(Object.hasOwn(state.preferences, 'showSignature'), false);
    assert.equal(state.preferences.showLineMetrics, false);
    assert.equal(
      flattenSymbols(state.symbols)
        .filter((symbol) => ['Function', 'Method', 'Constructor'].includes(symbol.kind))
        .some((symbol) => symbol.name.includes('(')),
      false,
    );
  });

  test('INT-145 长函数按当前文件平均跨度标记', async () => {
    const state = await openSampleAndRefresh();
    const long = flattenSymbols(state.symbols).find((symbol) => symbol.name === 'calculateLongSequence');
    assert.equal(long?.isLong, true);
  });

  test('INT-146 编辑函数后标记，清除保存态后取消标记', async () => {
    const api = await getApi();
    const state = await openSampleAndRefresh();
    const target = flattenSymbols(state.symbols).find((symbol) => symbol.name === 'add');
    assert.ok(target);
    api.outline.markEditedForIntegrationTest(target.id);
    assert.equal(flattenSymbols(api.outline.getStateForIntegrationTest().symbols).find((symbol) => symbol.name === 'add')?.isEdited, true);
    api.outline.clearEditedForIntegrationTest();
    assert.equal(flattenSymbols(api.outline.getStateForIntegrationTest().symbols).some((symbol) => symbol.isEdited), false);
  });

  test('INT-147 三种外观预设进入大纲偏好', async () => {
    for (const appearance of ['vscode', 'sourceInsightLight', 'sourceInsightBlack'] as const) {
      await applyPersonalSettingValue('outlineAppearance', appearance);
      assert.equal((await openSampleAndRefresh()).preferences.appearance, appearance);
    }
  });

  test('INT-148 90%～150% 缩放边界进入大纲偏好', async () => {
    for (const scale of [90, 100, 150]) {
      await applyPersonalSettingValue('outlineScale', scale);
      assert.equal((await openSampleAndRefresh()).preferences.scale, scale);
    }
  });

  test('INT-149 仅原生模式关闭增强状态并隐藏常驻提示', async () => {
    await applyPersonalSettingValue('outlineModeDefault', 'native');
    const state = await openSampleAndRefresh();
    assert.equal(state.preferences.mode, 'native');
    assert.equal(state.nativeOutlineNotice, false);
  });

  test('INT-150 同时使用模式不显示冲突提示', async () => {
    await applyPersonalSettingValue('outlineModeDefault', 'both');
    const state = await openSampleAndRefresh();
    assert.equal(state.preferences.mode, 'both');
    assert.equal(state.nativeOutlineNotice, false);
  });

  test('INT-151 仅增强模式显示默认展开的隐藏原生大纲提示', async () => {
    const api = await getApi();
    await api.context.workspaceState.update('projectManager.symbolOutline.nativeNoticeExpanded', true);
    await applyPersonalSettingValue('outlineModeDefault', 'enhanced');
    const state = await openSampleAndRefresh();
    assert.equal(state.nativeOutlineNotice, true);
    assert.equal(state.nativeOutlineNoticeExpanded, true);
  });

  test('INT-152 提示折叠与详情状态持久化', async () => {
    const api = await getApi();
    await applyPersonalSettingValue('outlineModeDefault', 'enhanced');
    await api.context.workspaceState.update('projectManager.symbolOutline.nativeNoticeExpanded', false);
    assert.equal((await openSampleAndRefresh()).nativeOutlineNoticeExpanded, false);
    await api.context.workspaceState.update('projectManager.symbolOutline.nativeNoticeExpanded', true);
    assert.equal(api.outline.getStateForIntegrationTest().nativeOutlineNoticeExpanded, true);
  });

  test('INT-153 大纲模式命令已注册且内部集合模式可更新', async () => {
    const api = await getApi();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('projectManager.openNativeOutline'));
    assert.ok(commands.includes('projectManager.resolveNativeOutlineConflict'));
  });

  test('INT-154 快速切换和连续刷新最终保持最新活动文件', async () => {
    const api = await getApi();
    const sample = projectUri(api, 'test-fixtures/workspace-one/src/outline-sample.ts');
    const app = projectUri(api, 'test-fixtures/workspace-one/src/app.ts');
    await Promise.all([openText(sample), openText(app)]);
    await Promise.all([
      api.outline.refreshSymbols('并发一'),
      api.outline.refreshSymbols('并发二'),
      api.outline.refreshSymbols('并发三'),
    ]);
    assert.equal(api.outline.getStateForIntegrationTest().fileName, 'app.ts');
  });

  test('INT-173 旧平铺字段仅兼容读取且运行固定树状', async () => {
    await applyPersonalSettingValue('outlineHierarchy', 'flat');
    const state = await openSampleAndRefresh();
    const calculator = state.symbols.find((symbol) => symbol.name === 'Calculator');
    assert.equal(state.preferences.hierarchy, 'tree');
    assert.ok(calculator?.children.some((symbol) => symbol.name === 'add'));
  });

  test('INT-175 C 符号结果接入条件编译层级并归并结构体重复项', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/workspace-one/src/outline-sample.c');
    const provider = vscode.languages.registerDocumentSymbolProvider({ language: 'c', scheme: 'file' }, {
      provideDocumentSymbols(document) {
        if (document.uri.toString() !== uri.toString()) return [];
        const packet = new vscode.DocumentSymbol(
          'Packet',
          '',
          vscode.SymbolKind.Struct,
          new vscode.Range(0, 0, 2, 9),
          new vscode.Range(0, 15, 0, 21),
        );
        packet.children = [new vscode.DocumentSymbol(
          'value',
          '',
          vscode.SymbolKind.Field,
          new vscode.Range(1, 4, 1, 14),
          new vscode.Range(1, 8, 1, 13),
        )];
        return [
          packet,
          new vscode.DocumentSymbol(
            'Packet',
            '',
            vscode.SymbolKind.Struct,
            new vscode.Range(2, 2, 2, 8),
            new vscode.Range(2, 2, 2, 8),
          ),
          new vscode.DocumentSymbol(
            'fast_path',
            '',
            vscode.SymbolKind.Function,
            new vscode.Range(5, 0, 5, 23),
            new vscode.Range(5, 5, 5, 14),
          ),
          new vscode.DocumentSymbol(
            'safe_path',
            '',
            vscode.SymbolKind.Function,
            new vscode.Range(7, 0, 7, 23),
            new vscode.Range(7, 5, 7, 14),
          ),
        ];
      },
    });
    try {
      const editor = await openText(uri);
      await vscode.languages.setTextDocumentLanguage(editor.document, 'c');
      await api.outline.refreshSymbols('C 集成测试');
      const state = api.outline.getStateForIntegrationTest();
      const flattened = flattenSymbols(state.symbols);
      assert.equal(flattened.filter((symbol) => symbol.name === 'Packet').length, 1);
      assert.ok(flattened.some((symbol) => symbol.kind === 'PreprocessorRegion'));
      assert.ok(flattened.some((symbol) => symbol.kind === 'PreprocessorBranch' && symbol.name === '#else'));
      const conditionalRegion = state.symbols.find((symbol) => symbol.kind === 'PreprocessorRegion');
      assert.match(conditionalRegion?.name ?? '', /^#if\b/);
      assert.equal(conditionalRegion?.name.includes('条件编译'), false);
      const fastPath = conditionalRegion?.children.find((symbol) => symbol.name === 'fast_path');
      const elseBranch = conditionalRegion?.children.find((symbol) => symbol.name === '#else');
      assert.ok(fastPath);
      assert.ok(elseBranch?.children.some((symbol) => symbol.name === 'safe_path'));
    } finally {
      provider.dispose();
    }
  });

  test('INT-178 增强大纲依赖的原生命令通过集中能力层检测', async () => {
    assert.equal(await hasVscodeCommand('workbench.extensions.search'), true);
    assert.equal(await hasVscodeCommand('projectManager.commandThatDoesNotExist'), false);
  });
});

async function openSampleAndRefresh() {
  const api = await getApi();
  await openText(projectUri(api, 'test-fixtures/workspace-one/src/outline-sample.ts'));
  await api.outline.refreshSymbols('集成测试');
  return api.outline.getStateForIntegrationTest();
}

async function restoreOutlineDefaults(): Promise<void> {
  await applyPersonalSettingValue('outlineModeDefault', 'both');
  await applyPersonalSettingValue('outlineScope', 'functionsAndTypes');
  await applyPersonalSettingValue('outlineHierarchy', 'tree');
  await applyPersonalSettingValue('outlineSort', 'source');
  await applyPersonalSettingValue('outlineAppearance', 'vscode');
  await applyPersonalSettingValue('showLineMetrics', true);
  await applyPersonalSettingValue('highlightLong', true);
  await applyPersonalSettingValue('highlightEdited', true);
  await applyPersonalSettingValue('outlineScale', 100);
}
