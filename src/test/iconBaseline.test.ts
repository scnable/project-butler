import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';

interface IconManifest {
  readonly version: number;
  readonly grid: string;
  readonly strokeWidth: number;
  readonly sourceRoot: string;
  readonly palette: string;
  readonly colorStrategy: {
    readonly role: string;
    readonly themes: readonly string[];
    readonly highContrast: string;
    readonly activityBar: string;
  };
  readonly icons: readonly {
    readonly id: string;
    readonly label: string;
    readonly source: string;
    readonly files: { readonly monochrome: string; readonly light: string; readonly dark: string };
  }[];
  readonly states: readonly {
    readonly id: string;
    readonly label: string;
    readonly file: string;
    readonly anchor: string;
  }[];
}

const baselineDirectory = path.resolve(__dirname, '../../media/icons/baseline');
const manifest = JSON.parse(
  fs.readFileSync(path.join(baselineDirectory, 'manifest.json'), 'utf8'),
) as IconManifest;
const palette = JSON.parse(
  fs.readFileSync(path.resolve(baselineDirectory, manifest.palette), 'utf8'),
) as {
  readonly version: number;
  readonly tokens: readonly string[];
  readonly modes: Record<string, Record<string, Record<string, string>>>;
};

const sourceInsightOutlineGroups = [
  ['symbol-function', 'symbol-method', 'symbol-constructor'],
  ['symbol-class', 'symbol-interface', 'symbol-struct', 'symbol-enum', 'symbol-type-parameter'],
  ['symbol-property', 'symbol-field', 'symbol-variable', 'symbol-enum-member'],
  ['symbol-file', 'symbol-module', 'symbol-namespace', 'symbol-package'],
  ['symbol-preprocessor-region', 'symbol-preprocessor-branch'],
] as const;

const geometryAttributes = new Set([
  'd', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'transform', 'stroke-width',
]);

function geometrySignature(source: string): readonly string[] {
  return [...source.matchAll(/<(path|rect|circle)\b([^>]*)>/g)].map((element) => {
    const elementName = element[1] ?? '';
    const rawAttributes = element[2] ?? '';
    const attributes = [...rawAttributes.matchAll(/([\w:-]+)="([^"]*)"/g)]
      .filter((attribute) => geometryAttributes.has(attribute[1] ?? ''))
      .map((attribute) => `${attribute[1] ?? ''}=${attribute[2] ?? ''}`)
      .sort();
    return `${elementName}:${attributes.join(';')}`;
  });
}

describe('统一标识视觉基线', () => {
  test('包含完整且语义唯一的基准图标', () => {
    assert.equal(manifest.version, 5);
    assert.equal(manifest.grid, '24x24');
    assert.equal(manifest.icons.length, 43);
    assert.equal(new Set(manifest.icons.map((icon) => icon.id)).size, 43);
    assert.ok(manifest.strokeWidth >= 2.7);
    assert.deepEqual(manifest.colorStrategy.themes, ['light', 'dark']);
    assert.equal(manifest.colorStrategy.highContrast, 'monochrome');
    assert.equal(manifest.colorStrategy.activityBar, 'monochrome');
  });

  test('每个图标只有一份几何源稿并使用集中调色板', () => {
    assert.equal(palette.version, 1);
    assert.deepEqual(palette.tokens, ['primary', 'surface', 'secondary', 'accent']);
    assert.deepEqual(Object.keys(palette.modes), ['monochrome', 'light', 'dark']);

    for (const icon of manifest.icons) {
      const source = fs.readFileSync(
        path.resolve(baselineDirectory, manifest.sourceRoot, icon.source),
        'utf8',
      );
      assert.match(source, /viewBox="0 0 24 24"/);
      assert.match(source, /\{\{(?:primary|secondary|accent|surface)\}\}/);
      assert.doesNotMatch(source, /#[0-9a-f]{3,8}/i);
    }
  });

  test('SVG 使用统一网格和主题前景色且不依赖字体', () => {
    for (const icon of manifest.icons) {
      const source = fs.readFileSync(path.join(baselineDirectory, icon.files.monochrome), 'utf8');
      assert.match(source, /viewBox="0 0 24 24"/);
      assert.match(source, /currentColor/);
      assert.doesNotMatch(source, /<text\b/i);
      assert.doesNotMatch(source, /#[0-9a-f]{3,8}/i);
      assert.doesNotMatch(source, /(?:href|xlink:href)\s*=\s*["']https?:\/\//i);
    }
  });

  test('浅色和深色资源完整，颜色数量由语义层次决定而非强制双色', () => {
    for (const icon of manifest.icons) {
      const monochromeSource = fs.readFileSync(
        path.join(baselineDirectory, icon.files.monochrome),
        'utf8',
      );
      for (const theme of manifest.colorStrategy.themes) {
        const file = icon.files[theme as 'light' | 'dark'];
        const source = fs.readFileSync(path.join(baselineDirectory, file), 'utf8');
        const colors = new Set(source.match(/#[0-9a-f]{6}/gi) ?? []);
        assert.match(source, /viewBox="0 0 24 24"/);
        assert.ok(colors.size >= 1, `${icon.id} 的 ${theme} 资源至少需要一种可见颜色`);
        assert.ok(colors.size <= 3, `${icon.id} 的 ${theme} 资源不得使用超过三种颜色`);
        assert.deepEqual(
          geometrySignature(source),
          geometrySignature(monochromeSource),
          `${icon.id} 的 ${theme} 资源必须与单色版保持相同几何`,
        );
        assert.doesNotMatch(source, /<text\b/i);
        assert.doesNotMatch(source, /(?:href|xlink:href)\s*=\s*["']https?:\/\//i);
      }
    }
  });

  test('Source Insight 风格大纲按类别统一颜色且不添加装饰性色', () => {
    const callableTiles = new Set(['symbol-function', 'symbol-method', 'symbol-constructor']);
    for (const icon of manifest.icons.filter((candidate) => candidate.id.startsWith('symbol-'))) {
      const source = fs.readFileSync(
        path.resolve(baselineDirectory, manifest.sourceRoot, icon.source),
        'utf8',
      );
      assert.doesNotMatch(source, /\{\{(?:secondary|accent)\}\}/, `${icon.id} 不应包含装饰性色`);
      if (callableTiles.has(icon.id)) {
        assert.match(source, /\{\{surface\}\}/, `${icon.id} 应保留 Source Insight 式同色系底板`);
      } else {
        assert.doesNotMatch(source, /\{\{surface\}\}/, `${icon.id} 不应无意义增加底板`);
      }
    }

    for (const theme of ['light', 'dark']) {
      const themePalette: Record<string, Record<string, string>> | undefined = palette.modes[theme];
      assert.ok(themePalette !== undefined);
      for (const group of sourceInsightOutlineGroups) {
        const groupColors: Set<string | undefined> = new Set<string | undefined>(
          group.map((id): string | undefined => themePalette[id]?.primary),
        );
        assert.equal(groupColors.size, 1, `${theme} 下同类大纲图标必须使用同一主色：${group.join(', ')}`);
      }
      for (const id of ['symbol-preprocessor-region', 'symbol-preprocessor-branch', 'symbol-macro-definition']) {
        const tokens: Record<string, string> | undefined = themePalette[id];
        assert.ok(tokens !== undefined);
        assert.equal(tokens.primary, tokens.secondary, `${id} 不应拆成不同色调`);
        assert.equal(tokens.primary, tokens.accent, `${id} 不应包含装饰性强调色`);
      }
    }
  });

  test('开发总览覆盖三种主题、双版本和四档尺寸', () => {
    const overview = fs.readFileSync(path.join(baselineDirectory, 'overview.html'), 'utf8');
    for (const theme of ['light', 'dark', 'hc']) assert.match(overview, new RegExp(`'${theme}'`));
    for (const size of [16, 20, 24, 32]) assert.match(overview, new RegExp(`\\b${size}\\b`));
    assert.match(overview, /monochrome/);
    assert.match(overview, /colorAsset/);
    assert.match(overview, /高对比度回退单色/);
    assert.match(overview, /url\('\.\.\/state\/warning\.svg'\)/);
    for (const icon of manifest.icons) {
      assert.match(overview, new RegExp(`\\['${icon.id}',`), `总览缺少 ${icon.id}`);
    }
  });

  test('状态角标独立于对象图标且使用固定小画布', () => {
    assert.deepEqual(
      manifest.states.map((state) => state.id),
      ['warning', 'edited', 'long-function', 'disabled'],
    );
    for (const state of manifest.states) {
      const source = fs.readFileSync(path.resolve(baselineDirectory, state.file), 'utf8');
      assert.match(source, /viewBox="0 0 8 8"/);
      assert.match(source, /currentColor/);
      assert.doesNotMatch(source, /<text\b/i);
    }
  });
});
