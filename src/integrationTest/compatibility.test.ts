import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createExportText, parseImportText } from '../projectCatalog/catalogTransfer';
import { getApi, projectUri } from './helpers';

suite('1.0.0 导出格式兼容夹具', () => {
  test('INT-219 v1 导出夹具使用旧版默认值并恢复项目', async () => {
    const { text, uri } = await readFixture('export-v1.project-butler-export.json');
    const preview = parseImportText(text, uri);
    assert.equal(preview.sourceKind, 'export');
    assert.equal(preview.catalogs[0]?.name, '导出 v1');
    assert.deepEqual(preview.catalogs[0]?.features.tabs, { autoOrganize: false });
    assert.deepEqual(preview.catalogs[0]?.features.symbolOutline, { mode: 'both' });
    assert.deepEqual(preview.catalogs[0]?.features.todo, {});
    assert.equal(preview.catalogs[0]?.projects.length, 1);
  });

  test('INT-220 v3 导出夹具保持当前集合功能和项目字段', async () => {
    const { text, uri } = await readFixture('export-v3.project-butler-export.json');
    const preview = parseImportText(text, uri);
    const catalog = preview.catalogs[0];
    assert.equal(catalog?.features.tabs.autoOrganize, true);
    assert.equal(catalog?.features.symbolOutline.mode, 'enhanced');
    assert.deepEqual(catalog?.features.todo, {
      enabled: true, tags: ['TODO', 'REVIEW'], markdownTasks: true,
    });
    assert.equal(catalog?.projects[0]?.description, '当前导出格式');
    assert.deepEqual(catalog?.projects[0]?.tags, ['current']);

    const roundTrip = parseImportText(createExportText([catalog!], uri).text, uri);
    assert.deepEqual(roundTrip.catalogs[0]?.features, catalog?.features);
    assert.equal(roundTrip.catalogs[0]?.projects[0]?.alias, catalog?.projects[0]?.alias);
  });

  test('INT-221 v3 导出的无效字段逐字段回退', async () => {
    const { text, uri } = await readFixture('export-v3-partial-invalid.project-butler-export.json');
    const preview = parseImportText(text, uri);
    const features = preview.catalogs[0]?.features;
    assert.deepEqual(features?.tabs, {});
    assert.equal(features?.symbolOutline.mode, 'enhanced');
    assert.equal(features?.todo.enabled, undefined);
    assert.deepEqual(features?.todo.tags, ['FIXME']);
    assert.equal(features?.todo.markdownTasks, true);
    assert.ok(preview.defaultedFieldCount >= 2);
    assert.ok(preview.messages.some((message) => message.includes('标签覆盖值')));
    assert.ok(preview.messages.some((message) => message.includes('TODO enabled')));
  });

  test('INT-222 未来导出格式只应用当前认识的合法字段', async () => {
    const { text, uri } = await readFixture('export-future.project-butler-export.json');
    const preview = parseImportText(text, uri);
    const catalog = preview.catalogs[0];
    assert.equal(catalog?.features.tabs.autoOrganize, false);
    assert.equal(catalog?.features.symbolOutline.mode, 'native');
    assert.deepEqual(catalog?.features.todo, {
      enabled: false, tags: ['BUG'], markdownTasks: false,
    });
    assert.ok(preview.messages.some((message) => message.includes('版本为 99')));
    assert.doesNotMatch(JSON.stringify(preview.catalogs), /must-not-run|futureFeature|futureTodoField/u);
  });
});

async function readFixture(fileName: string): Promise<{ text: string; uri: vscode.Uri }> {
  const api = await getApi();
  const uri = projectUri(api, `test-fixtures/compatibility/${fileName}`);
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  return { text, uri };
}
