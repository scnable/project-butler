import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { parseProjectCatalogText } from '../projectCatalog/catalogModel';
import { loadCatalogLibrary } from '../projectCatalog/catalogStore';

const FIXTURE_ROOT = path.resolve(__dirname, '../../test-fixtures/compatibility');

describe('1.0.0 配置兼容夹具', () => {
  it('旧集合文件 v1、v2 和当前 v3 保持稳定解析结果', () => {
    const cases = [
      ['legacy-catalog-v1.project-butler.json', 'legacy', false, 'both'],
      ['legacy-catalog-v2.project-butler.json', 'legacy', true, 'both'],
      ['catalog-v3.project-butler.json', 'current', false, 'enhanced'],
    ] as const;
    for (const [fileName, compatibility, autoOrganize, outlineMode] of cases) {
      const catalog = parseProjectCatalogText(readFixture(fileName));
      assert.equal(catalog.compatibility, compatibility, fileName);
      assert.equal(catalog.features.tabs.autoOrganize, autoOrganize, fileName);
      assert.equal(catalog.features.symbolOutline.mode, outlineMode, fileName);
      assert.equal(catalog.projects.length, 1, fileName);
    }
  });

  it('内部存储 v1、v2 和 v3 均规范化为当前存储版本', () => {
    const expected = [
      ['internal-storage-v1.json', 'storage-v1', true, 'enhanced', {}],
      ['internal-storage-v2.json', 'storage-v2', false, 'both', {}],
      ['internal-storage-v3.json', 'storage-v3', true, 'native', {
        enabled: true, tags: ['TODO', 'DEBUG'], markdownTasks: false,
      }],
    ] as const;
    for (const [fileName, id, autoOrganize, outlineMode, todo] of expected) {
      const result = loadCatalogLibrary(JSON.parse(readFixture(fileName)) as unknown);
      assert.equal(result.library.storageVersion, 3, fileName);
      assert.equal(result.library.catalogs[0]?.id, id, fileName);
      assert.equal(result.library.catalogs[0]?.features.tabs.autoOrganize, autoOrganize, fileName);
      assert.equal(result.library.catalogs[0]?.features.symbolOutline.mode, outlineMode, fileName);
      assert.deepEqual(result.library.catalogs[0]?.features.todo, todo, fileName);
    }
  });

  it('当前存储的局部无效字段独立回退且不影响有效兄弟字段', () => {
    const result = loadCatalogLibrary(JSON.parse(readFixture('internal-storage-v3-partial-invalid.json')) as unknown);
    const features = result.library.catalogs[0]?.features;
    assert.equal(features?.tabs.autoOrganize, true);
    assert.equal(features?.symbolOutline.mode, undefined);
    assert.equal(features?.todo.enabled, undefined);
    assert.deepEqual(features?.todo.tags, ['FIXME', 'DEBUG']);
    assert.equal(features?.todo.markdownTasks, false);
    assert.ok(result.issues.some((issue) => issue.includes('函数大纲')));
    assert.ok(result.issues.some((issue) => issue.includes('TODO enabled')));
  });

  it('不支持的未来内部存储安全回退为空集合库', () => {
    const result = loadCatalogLibrary(JSON.parse(readFixture('internal-storage-future.json')) as unknown);
    assert.equal(result.library.storageVersion, 3);
    assert.deepEqual(result.library.catalogs, []);
    assert.match(result.issues[0] ?? '', /不受支持/);
  });
});

function readFixture(fileName: string): string {
  return readFileSync(path.join(FIXTURE_ROOT, fileName), 'utf8');
}
