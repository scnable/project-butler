import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  getSymbolIconMetadata,
  IconSemantic,
  resolveIconResource,
  STANDARD_SYMBOL_KIND_NAMES,
  SYNTHETIC_SYMBOL_KIND_NAMES,
} from '../visual/iconSemantics';

const projectRoot = path.resolve(__dirname, '../..');

describe('统一图标语义映射', () => {
  it('覆盖 VS Code 的全部 26 种标准符号类型', () => {
    assert.equal(STANDARD_SYMBOL_KIND_NAMES.length, 26);
    assert.equal(new Set(STANDARD_SYMBOL_KIND_NAMES).size, 26);

    for (const kind of STANDARD_SYMBOL_KIND_NAMES) {
      const metadata = getSymbolIconMetadata(kind);
      assert.equal(metadata.kind, kind);
      assert.equal(metadata.known, true);
      assert.notEqual(metadata.semantic, 'symbol.unknown');
      assert.ok(metadata.label.length > 0);
    }
  });

  it('条件编译与宏定义扩展类型具有独立语义', () => {
    assert.deepEqual(SYNTHETIC_SYMBOL_KIND_NAMES, [
      'PreprocessorRegion',
      'PreprocessorBranch',
      'MacroDefinition',
    ]);
    assert.equal(
      getSymbolIconMetadata('PreprocessorRegion').semantic,
      'symbol.preprocessor-region',
    );
    assert.equal(
      getSymbolIconMetadata('PreprocessorBranch').semantic,
      'symbol.preprocessor-branch',
    );
    assert.equal(
      getSymbolIconMetadata('MacroDefinition').semantic,
      'symbol.macro-definition',
    );
  });

  it('未知或未来新增的符号类型安全回退', () => {
    const metadata = getSymbolIconMetadata('FutureSymbolKind');
    assert.deepEqual(metadata, {
      kind: 'Unknown',
      label: '未知符号',
      semantic: 'symbol.unknown',
      known: false,
    });

    const resource = resolveIconResource(metadata.semantic, 'dark');
    assert.equal(resource.assetId, 'symbol-generic');
    assert.equal(resource.usedFallback, false);
  });

  it('已知符号均直接解析到专用资源', () => {
    const functionResource = resolveIconResource('symbol.function', 'light');
    assert.equal(functionResource.assetId, 'symbol-function');
    assert.equal(functionResource.usedFallback, false);
    assert.equal(
      functionResource.relativePath,
      'media/icons/baseline/color/light/symbol-function.svg',
    );

    const namespaceResource = resolveIconResource('symbol.namespace', 'dark');
    assert.equal(namespaceResource.assetId, 'symbol-namespace');
    assert.equal(namespaceResource.usedFallback, false);
    assert.equal(
      namespaceResource.relativePath,
      'media/icons/baseline/color/dark/symbol-namespace.svg',
    );
  });

  it('每种已知符号使用独立资产，只有未知类型使用通用图标', () => {
    const kinds = [...STANDARD_SYMBOL_KIND_NAMES, ...SYNTHETIC_SYMBOL_KIND_NAMES];
    const resources = kinds.map((kind) =>
      resolveIconResource(getSymbolIconMetadata(kind).semantic, 'light'));

    assert.equal(resources.every((resource) => resource.usedFallback === false), true);
    assert.equal(new Set(resources.map((resource) => resource.assetId)).size, kinds.length);
    assert.equal(
      resolveIconResource('symbol.preprocessor-region', 'light').assetId,
      'symbol-preprocessor-region',
    );
    assert.equal(
      resolveIconResource('symbol.preprocessor-branch', 'light').assetId,
      'symbol-preprocessor-branch',
    );
    assert.equal(
      resolveIconResource('symbol.macro-definition', 'light').assetId,
      'symbol-macro-definition',
    );
  });

  it('高对比度使用单色资源，状态角标不跟随彩色主题', () => {
    const highContrast = resolveIconResource('symbol.class', 'highContrast');
    assert.equal(highContrast.theme, 'monochrome');
    assert.equal(
      highContrast.relativePath,
      'media/icons/baseline/symbol-class.svg',
    );

    const warning = resolveIconResource('state.warning', 'dark');
    assert.equal(warning.theme, 'monochrome');
    assert.equal(warning.relativePath, 'media/icons/state/warning.svg');
  });

  it('解析得到的所有运行时资源均实际存在', () => {
    const semantics: IconSemantic[] = [
      'product',
      'catalog',
      'project',
      'workspace',
      'config',
      'preferences',
      'resources',
      'external-file',
      'context.member',
      'context.external',
      'context.empty',
      'project.unavailable.folder',
      'project.unavailable.workspace',
      'file',
      ...STANDARD_SYMBOL_KIND_NAMES.map((kind) => getSymbolIconMetadata(kind).semantic),
      ...SYNTHETIC_SYMBOL_KIND_NAMES.map((kind) => getSymbolIconMetadata(kind).semantic),
      'symbol.unknown',
      'state.warning',
      'state.edited',
      'state.long-function',
      'state.disabled',
    ];

    for (const semantic of semantics) {
      for (const theme of ['monochrome', 'light', 'dark', 'highContrast'] as const) {
        const resource = resolveIconResource(semantic, theme);
        assert.equal(
          fs.existsSync(path.resolve(projectRoot, resource.relativePath)),
          true,
          `${semantic}/${theme} 指向不存在的资源：${resource.relativePath}`,
        );
      }
    }
  });

  it('项目不可用状态保留文件夹或工作区类型', () => {
    const folder = resolveIconResource('project.unavailable.folder', 'light');
    const workspace = resolveIconResource('project.unavailable.workspace', 'light');
    assert.equal(folder.assetId, 'project-warning');
    assert.equal(workspace.assetId, 'workspace-warning');
    assert.equal(folder.usedFallback, false);
    assert.equal(workspace.usedFallback, false);
  });
});
