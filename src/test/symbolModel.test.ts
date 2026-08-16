import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyFunctionMetrics,
  createEditKey,
  createSymbolId,
  findCurrentSymbol,
  OutlineSymbol,
  projectSymbols,
} from '../symbolOutline/symbolModel';

function symbol(
  name: string,
  kind: string,
  startLine: number,
  endLine: number,
  children: OutlineSymbol[] = [],
  parentPath = '',
): OutlineSymbol {
  const start = { line: startLine, character: 0 };
  const end = { line: endLine, character: 1 };
  return {
    id: createSymbolId('file:///demo.ts', kind, name, parentPath, start),
    editKey: createEditKey(kind, name, parentPath),
    name,
    detail: '',
    containerName: parentPath,
    parentPath,
    kind,
    range: { start, end },
    selectionRange: { start, end: start },
    span: endLine - startLine + 1,
    isLong: false,
    isEdited: false,
    isContext: false,
    children,
  };
}

const defaults = {
  scope: 'functionsAndTypes' as const,
  hierarchy: 'tree' as const,
  sort: 'source' as const,
  query: '',
  locale: 'zh-CN',
};

describe('函数大纲领域模型', () => {
  it('仅函数模式保留必要的类型祖先', () => {
    const method = symbol('run', 'Method', 2, 4, [], 'Demo');
    const type = symbol('Demo', 'Class', 1, 5, [method]);
    const result = projectSymbols([type], { ...defaults, scope: 'functions' });

    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, 'Demo');
    assert.equal(result[0]?.isContext, true);
    assert.equal(result[0]?.children[0]?.name, 'run');
  });

  it('默认函数与类型范围显示宏定义但仅函数范围不显示对象宏', () => {
    const macro = symbol('BUFFER_SIZE', 'MacroDefinition', 0, 0);
    assert.deepEqual(
      projectSymbols([macro], defaults).map((item) => item.name),
      ['BUFFER_SIZE'],
    );
    assert.deepEqual(
      projectSymbols([macro], { ...defaults, scope: 'functions' }),
      [],
    );
  });

  it('平铺模式移除父子层级并过滤类型', () => {
    const method = symbol('run', 'Method', 2, 4, [], 'Demo');
    const type = symbol('Demo', 'Class', 1, 5, [method]);
    const result = projectSymbols([type], {
      ...defaults,
      scope: 'functions',
      hierarchy: 'flat',
    });

    assert.deepEqual(result.map((item) => item.name), ['run']);
    assert.equal(result[0]?.children.length, 0);
  });

  it('名称排序忽略大小写并使用数字顺序', () => {
    const result = projectSymbols([
      symbol('task10', 'Function', 1, 1),
      symbol('Task2', 'Function', 2, 2),
    ], { ...defaults, sort: 'name' });

    assert.deepEqual(result.map((item) => item.name), ['Task2', 'task10']);
  });

  it('类型加名称排序把类型放到函数之前', () => {
    const result = projectSymbols([
      symbol('work', 'Function', 1, 1),
      symbol('Demo', 'Class', 2, 2),
    ], { ...defaults, sort: 'typeName' });

    assert.deepEqual(result.map((item) => item.name), ['Demo', 'work']);
  });

  it('搜索签名并保留匹配条目路径', () => {
    const method = symbol('run', 'Method', 2, 4, [], 'Demo');
    method.detail = '(target: string)';
    const type = symbol('Demo', 'Class', 1, 5, [method]);
    const result = projectSymbols([type], { ...defaults, query: 'TARGET' });

    assert.equal(result[0]?.isContext, true);
    assert.equal(result[0]?.children[0]?.name, 'run');
  });

  it('跨度高于文件函数平均值时标记为长函数', () => {
    const result = applyFunctionMetrics([
      symbol('short', 'Function', 1, 2),
      symbol('long', 'Function', 4, 13),
    ]);

    assert.equal(result[0]?.isLong, false);
    assert.equal(result[1]?.isLong, true);
  });

  it('当前位置选择最内层符号', () => {
    const method = symbol('run', 'Method', 2, 4, [], 'Demo');
    const type = symbol('Demo', 'Class', 1, 8, [method]);
    assert.equal(findCurrentSymbol([type], { line: 3, character: 0 })?.name, 'run');
    assert.equal(findCurrentSymbol([type], { line: 7, character: 0 })?.name, 'Demo');
  });

  it('函数内部存在更小的数据符号时仍优先选择函数', () => {
    const local = symbol('target', 'Variable', 3, 3, [], 'Demo › run');
    const method = symbol('run', 'Method', 2, 5, [local], 'Demo');
    const type = symbol('Demo', 'Class', 1, 8, [method]);

    assert.equal(findCurrentSymbol([type], { line: 3, character: 0 })?.name, 'run');
  });
});
