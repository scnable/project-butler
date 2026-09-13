import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStoredCatalog } from '../projectCatalog/catalogStore';
import { applyPendingIdentityMigration, createIdentityMigration, MIGRATION_PENDING_KEY,
  parseIdentityMigration, stageIdentityMigration, MigrationState } from '../migration/identityMigration';

class MemoryState implements MigrationState {
  readonly values = new Map<string, unknown>();
  failure: string | undefined;
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (key === this.failure) throw new Error('模拟写入失败');
    if (value === undefined) this.values.delete(key); else this.values.set(key, value);
  }
}
const roots = ['file:///project'];
const libraryKey = 'projectManager.catalogLibrary.v1';
function fixture(): { text: string; catalogId: string } {
  const global = new MemoryState();
  const workspace = new MemoryState();
  const catalog = createStoredCatalog('迁移集合', [{ alias: '项目', uri: roots[0]!, type: 'folder' }]);
  global.values.set(libraryKey, { storageVersion: 3, catalogs: [catalog] });
  global.values.set('secret', '不得导出');
  workspace.values.set('projectManager.todo.diskCache.v1', '不得导出');
  workspace.values.set('projectManager.catalogLibrary.activeId', catalog.id);
  workspace.values.set('projectManager.exclusionConsolidationSnapshots.v1', [
    { folderUri: roots[0], parentPattern: 'src/**', entries: [{ targetId: 'explorer', pattern: 'src/test/**', value: true }] },
  ]);
  return { text: createIdentityMigration(global, workspace, roots), catalogId: catalog.id };
}
test('身份迁移只导出必要集合与恢复状态，不导出秘密或 TODO 缓存', () => {
  const { text } = fixture();
  assert.doesNotMatch(text, /不得导出|diskCache|secret/);
  const data = parseIdentityMigration(text, roots);
  assert.equal(data.source, 'local-development.project-butler');
  assert.equal(data.target, 'scnable.catlas-hub');
  assert.equal(Object.keys(data.global).length, 1);
});
test('身份迁移拒绝错误来源、未来版本、工作区和未知状态键', () => {
  const { text } = fixture();
  for (const mutate of [
    (value: any) => { value.source = 'other.extension'; },
    (value: any) => { value.version = 9; },
    (value: any) => { value.workspace['unknown.key'] = true; },
    (value: any) => { value.workspace['projectManager.exclusionConsolidationSnapshots.v1'][0].folderUri = 'file:///other'; },
  ]) {
    const data = JSON.parse(text); mutate(data);
    assert.throws(() => parseIdentityMigration(JSON.stringify(data), roots));
  }
  assert.throws(() => parseIdentityMigration(text, ['file:///other']));
  assert.throws(() => parseIdentityMigration(' '.repeat(4 * 1024 * 1024 + 1), roots));
  assert.throws(() => parseIdentityMigration('{"__proto__":{}}', roots));
});
test('身份迁移确认暂存不直接改运行数据，启动应用后重复导入安全', async () => {
  const { text, catalogId } = fixture();
  const global = new MemoryState(); const workspace = new MemoryState();
  await stageIdentityMigration(text, roots, global, workspace);
  assert.equal(global.get(libraryKey), undefined);
  assert.ok(workspace.get(MIGRATION_PENDING_KEY));
  assert.equal(await applyPendingIdentityMigration(roots, global, workspace), true);
  assert.equal(workspace.get('projectManager.catalogLibrary.activeId'), catalogId);
  assert.equal(workspace.get(MIGRATION_PENDING_KEY), undefined);
  await stageIdentityMigration(text, roots, global, workspace);
  assert.equal(await applyPendingIdentityMigration(roots, global, workspace), true);
});
test('身份迁移遇到已有不同数据不覆盖、不暂存', async () => {
  const { text } = fixture();
  const global = new MemoryState(); const workspace = new MemoryState();
  global.values.set(libraryKey, { storageVersion: 3, catalogs: [] });
  await assert.rejects(stageIdentityMigration(text, roots, global, workspace), /冲突/);
  assert.equal(workspace.get(MIGRATION_PENDING_KEY), undefined);
  assert.deepEqual(global.get(libraryKey), { storageVersion: 3, catalogs: [] });
});
test('身份迁移写入中断保留暂存，下次启动继续且不重复覆盖', async () => {
  const { text } = fixture();
  const global = new MemoryState(); const workspace = new MemoryState();
  await stageIdentityMigration(text, roots, global, workspace);
  workspace.failure = 'projectManager.catalogLibrary.activeId';
  await assert.rejects(applyPendingIdentityMigration(roots, global, workspace), /模拟写入失败/);
  assert.ok(global.get(libraryKey));
  assert.ok(workspace.get(MIGRATION_PENDING_KEY));
  workspace.failure = undefined;
  assert.equal(await applyPendingIdentityMigration(roots, global, workspace), true);
  assert.equal(workspace.get(MIGRATION_PENDING_KEY), undefined);
});
