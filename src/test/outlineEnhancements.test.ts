import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createMacroSymbols,
  createPreprocessorSymbols,
  enhanceOutlineSymbols,
  mergeDuplicateStructSymbols,
} from '../symbolOutline/outlineEnhancements';
import {
  createEditKey,
  createSymbolId,
  flattenSymbols,
  OutlineSymbol,
} from '../symbolOutline/symbolModel';

function symbol(
  name: string,
  kind: string,
  startLine: number,
  endLine: number,
  children: OutlineSymbol[] = [],
  parentPath = '',
  selectionLine = startLine,
): OutlineSymbol {
  const start = { line: startLine, character: 0 };
  const end = { line: endLine, character: 20 };
  const selectionStart = { line: selectionLine, character: 0 };
  return {
    id: createSymbolId('file:///outline.c', kind, name, parentPath, selectionStart),
    editKey: createEditKey(kind, name, parentPath),
    name,
    detail: '',
    containerName: parentPath,
    parentPath,
    kind,
    range: { start, end },
    selectionRange: { start: selectionStart, end: { line: selectionLine, character: name.length } },
    span: endLine - startLine + 1,
    isLong: false,
    isEdited: false,
    isContext: false,
    children,
  };
}

describe('函数大纲增强模型', () => {
  it('识别对象宏、函数式宏和多行宏', () => {
    const source = [
      '#define BUFFER_SIZE 128',
      '#define MAX_VALUE(a, b) ((a) > (b) ? (a) : (b))',
      '#define MULTILINE(value) \\',
      '  ((value) + \\',
      '   1)',
    ].join('\n');
    const macros = createMacroSymbols(source, 'file:///outline.c');

    assert.deepEqual(macros.map((macro) => ({
      name: macro.name,
      detail: macro.detail,
      start: macro.range.start.line,
      end: macro.range.end.line,
      kind: macro.kind,
    })), [
      { name: 'BUFFER_SIZE', detail: '', start: 0, end: 0, kind: 'MacroDefinition' },
      { name: 'MAX_VALUE', detail: '(a, b)', start: 1, end: 1, kind: 'MacroDefinition' },
      { name: 'MULTILINE', detail: '(value)', start: 2, end: 4, kind: 'MacroDefinition' },
    ]);
  });

  it('忽略注释中的伪宏并保留字符串形式的宏内容', () => {
    const source = [
      '// #define COMMENTED 1',
      '/*',
      '#define BLOCKED 2',
      '*/',
      '#define MESSAGE "// not a comment"',
    ].join('\n');
    assert.deepEqual(
      createMacroSymbols(source, 'file:///outline.c').map((macro) => macro.name),
      ['MESSAGE'],
    );
  });

  it('宏进入条件编译分支并替换同位置语言提供器别名', () => {
    const source = [
      '#ifdef FEATURE',
      '#define LIMIT(value) (value)',
      '#endif',
    ].join('\n');
    const result = enhanceOutlineSymbols([
      symbol('LIMIT(value)', 'Function', 1, 1, [], '', 1),
    ], source, 'c', 'file:///outline.c');
    const flattened = flattenSymbols(result);

    assert.equal(flattened.filter((item) => item.name === 'LIMIT').length, 1);
    assert.equal(flattened.some((item) => item.name === 'LIMIT(value)'), false);
    assert.equal(flattened.find((item) => item.name === 'LIMIT')?.kind, 'MacroDefinition');
    assert.equal(result[0]?.children[0]?.children[0]?.name, 'LIMIT');
  });

  it('普通常量不会被宏去重逻辑误删', () => {
    const source = '#define LIMIT 8\nconst int other = 4;';
    const result = enhanceOutlineSymbols([
      symbol('other', 'Constant', 1, 1),
    ], source, 'c', 'file:///outline.c');
    assert.deepEqual(flattenSymbols(result).map((item) => item.name), ['LIMIT', 'other']);
  });

  it('把 C 条件编译分支和其中的函数合成为树状上下文', () => {
    const source = [
      '#if defined(USE_TCP)',
      'void start_tcp(void) {}',
      '#else',
      'void start_udp(void) {}',
      '#endif',
    ].join('\n');
    const result = enhanceOutlineSymbols([
      symbol('start_tcp', 'Function', 1, 1),
      symbol('start_udp', 'Function', 3, 3),
    ], source, 'c', 'file:///outline.c');

    assert.equal(result.length, 1);
    assert.equal(result[0]?.kind, 'PreprocessorRegion');
    assert.deepEqual(result[0]?.children.map((item) => item.name), [
      '#if defined(USE_TCP)',
      '#else',
    ]);
    assert.equal(result[0]?.children[0]?.children[0]?.name, 'start_tcp');
    assert.equal(result[0]?.children[1]?.children[0]?.name, 'start_udp');
  });

  it('保留嵌套条件编译层级', () => {
    const source = [
      '#ifdef OUTER',
      '#if INNER',
      'void nested(void) {}',
      '#endif',
      '#endif',
    ].join('\n');
    const result = enhanceOutlineSymbols([
      symbol('nested', 'Function', 2, 2),
    ], source, 'cpp', 'file:///outline.cpp');
    const flattened = flattenSymbols(result);

    assert.deepEqual(
      flattened.filter((item) => item.kind === 'PreprocessorRegion').map((item) => item.name),
      ['条件编译 · #ifdef OUTER', '条件编译 · #if INNER'],
    );
    assert.equal(flattened.find((item) => item.name === 'nested')?.parentPath, '');
  });

  it('缺少 endif 时不生成跨越文件末尾的错误节点', () => {
    const regions = createPreprocessorSymbols('#if BROKEN\nvoid work(void) {}', 'file:///broken.c');
    assert.deepEqual(regions, []);
  });

  it('忽略行注释和块注释中的伪条件编译指令', () => {
    const source = [
      '// #if LINE_COMMENT',
      '/*',
      '#if BLOCK_COMMENT',
      '#endif',
      '*/',
      '#if REAL_VALUE',
      '#endif',
    ].join('\n');
    const regions = createPreprocessorSymbols(source, 'file:///comments.c');

    assert.deepEqual(regions.map((item) => item.name), ['条件编译 · #if REAL_VALUE']);
  });

  it('非 C 家族语言不添加预处理节点', () => {
    const original = symbol('run', 'Function', 1, 1);
    const result = enhanceOutlineSymbols([original], '#if VALUE\n#endif', 'typescript', 'file:///demo.ts');
    assert.deepEqual(result.map((item) => item.name), ['run']);
  });

  it('归并同容器同范围的结构体首尾重复项并保留成员', () => {
    const field = symbol('value', 'Field', 2, 2, [], 'Packet');
    const definition = symbol('Packet', 'Struct', 1, 6, [field]);
    const closing = symbol('Packet', 'Struct', 6, 6, [], '', 6);
    const result = mergeDuplicateStructSymbols([definition, closing]);

    assert.equal(result.length, 1);
    assert.equal(result[0]?.kind, 'Struct');
    assert.deepEqual(result[0]?.children.map((item) => item.name), ['value']);
  });

  it('不归并不同容器或前置声明与正式定义', () => {
    const namespaceOne = symbol('Packet', 'Struct', 1, 4, [], 'One');
    const namespaceTwo = symbol('Packet', 'Struct', 1, 4, [], 'Two');
    const declaration = symbol('Packet', 'Struct', 10, 10);
    const definition = symbol('Packet', 'Struct', 20, 30);
    const result = mergeDuplicateStructSymbols([
      namespaceOne,
      namespaceTwo,
      declaration,
      definition,
    ]);

    assert.equal(result.length, 4);
  });
});
