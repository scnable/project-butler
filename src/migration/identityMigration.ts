/**
 * 旧扩展到正式扩展的一次性状态迁移。只访问列明的 Memento 键，不读取 VS Code 数据库或凭据。
 * 导入先暂存，重载后在各功能初始化前应用；已有不同值一律拒绝覆盖。
 * 中途失败保留暂存内容：下次启动允许相同值重复应用，继续写入尚未完成的键。
 */
import { loadCatalogLibrary } from '../projectCatalog/catalogStore';

export const OLD_EXTENSION_ID = 'local-development.project-butler';
export const NEW_EXTENSION_ID = 'scnable.catlas-hub';
export const MIGRATION_PENDING_KEY = 'projectManager.identityMigration.pending.v1';
export const MIGRATION_MAX_BYTES = 4 * 1024 * 1024;
export const GLOBAL_MIGRATION_KEYS = [
  'projectManager.catalogLibrary.v1', 'projectManager.catalogLibrary.lastActiveId',
  'projectManager.catalogLibrary.projectBindings',
] as const;
export const WORKSPACE_MIGRATION_KEYS = [
  'projectManager.catalogLibrary.activeId', 'projectManager.catalogLibrary.restoreSuppressed',
  'projectManager.exclusionConsolidationSnapshots.v1',
  'projectManager.openedFilesView.nativeOpenEditorsRestore',
  'projectManager.openedFilesView.nativeOpenEditorsHiddenByCommand',
  'projectManager.openedFilesView.nativeOpenEditorsDecision',
] as const;
export interface MigrationState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}
export interface IdentityMigration {
  format: 'catlas-hub-identity-migration';
  version: 1;
  source: typeof OLD_EXTENSION_ID;
  target: typeof NEW_EXTENSION_ID;
  roots: string[];
  global: Record<string, unknown>;
  workspace: Record<string, unknown>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const shortString = (value: unknown): value is string => typeof value === 'string' && value.length <= 8192;
const uri = (value: unknown): value is string => shortString(value) && /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
const fail = (): never => { throw new Error('迁移文件格式、来源或数据不受支持。'); };
function bounded(value: unknown, depth = 0): void {
  if (depth > 20) fail();
  if (Array.isArray(value)) { for (const item of value) bounded(item, depth + 1); }
  else if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail();
      bounded(item, depth + 1);
    }
  }
}
function same(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function validValue(key: string, value: unknown, roots: readonly string[]): boolean {
  if (key === 'projectManager.catalogLibrary.v1') {
    const loaded = loadCatalogLibrary(value);
    return record(value) && Array.isArray(value.catalogs) && loaded.issues.length === 0
      && loaded.library.catalogs.every((catalog) => catalog.projects.every((project) => uri(project.uri)));
  }
  if (key.endsWith('.lastActiveId') || key.endsWith('.activeId')) return shortString(value);
  if (key.endsWith('.projectBindings')) return record(value) && Object.entries(value).every(([path, id]) => uri(path) && shortString(id));
  if (key.endsWith('.restoreSuppressed') || key.endsWith('.nativeOpenEditorsHiddenByCommand')) return typeof value === 'boolean';
  if (key.endsWith('.nativeOpenEditorsDecision')) return value === 'accepted' || value === 'declined';
  if (key.endsWith('.nativeOpenEditorsRestore')) return record(value)
    && ['global', 'workspace'].includes(String(value.target)) && typeof value.hadExplicitValue === 'boolean'
    && value.writtenValue === 0 && (!value.hadExplicitValue || (Number.isSafeInteger(value.previousValue) && Number(value.previousValue) >= 0));
  if (key.endsWith('.exclusionConsolidationSnapshots.v1')) return Array.isArray(value) && value.every((snapshot) =>
    record(snapshot) && roots.includes(String(snapshot.folderUri)) && shortString(snapshot.parentPattern)
    && Array.isArray(snapshot.entries) && snapshot.entries.every((entry) => record(entry)
      && ['explorer', 'search', 'watcher'].includes(String(entry.targetId)) && shortString(entry.pattern)
      && (typeof entry.value === 'boolean' || (record(entry.value) && shortString(entry.value.when)))));
  return false;
}

export function parseIdentityMigration(text: string, roots: readonly string[]): IdentityMigration {
  if (Buffer.byteLength(text, 'utf8') > MIGRATION_MAX_BYTES) throw new Error('迁移文件超过 4 MiB，已拒绝读取。');
  const raw: unknown = JSON.parse(text);
  bounded(raw);
  if (!record(raw) || raw.format !== 'catlas-hub-identity-migration' || raw.version !== 1
    || raw.source !== OLD_EXTENSION_ID || raw.target !== NEW_EXTENSION_ID
    || !Array.isArray(raw.roots) || !raw.roots.every(uri) || new Set(raw.roots).size !== raw.roots.length
    || !same([...raw.roots].sort(), [...roots].sort()) || !record(raw.global) || !record(raw.workspace)) return fail();
  for (const [values, keys] of [[raw.global, GLOBAL_MIGRATION_KEYS], [raw.workspace, WORKSPACE_MIGRATION_KEYS]] as const) {
    for (const [key, value] of Object.entries(values)) {
      if (!(keys as readonly string[]).includes(key) || !validValue(key, value, roots)) fail();
    }
  }
  return raw as unknown as IdentityMigration;
}

export function createIdentityMigration(global: MigrationState, workspace: MigrationState, roots: readonly string[]): string {
  const pick = (state: MigrationState, keys: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(keys.map((key) => [key, state.get(key)]).filter(([, value]) => value !== undefined));
  const text = JSON.stringify({ format: 'catlas-hub-identity-migration', version: 1,
    source: OLD_EXTENSION_ID, target: NEW_EXTENSION_ID, roots: [...roots],
    global: pick(global, GLOBAL_MIGRATION_KEYS), workspace: pick(workspace, WORKSPACE_MIGRATION_KEYS) }, null, 2);
  parseIdentityMigration(text, roots);
  return text;
}

export function assertMigrationNoConflicts(data: IdentityMigration, global: MigrationState, workspace: MigrationState): void {
  for (const [incoming, state] of [[data.global, global], [data.workspace, workspace]] as const) {
    for (const [key, value] of Object.entries(incoming)) {
      const existing = state.get(key);
      if (existing !== undefined && !same(existing, value)) throw new Error(`已有状态与迁移数据冲突，未覆盖：${key}`);
    }
  }
}

export async function stageIdentityMigration(text: string, roots: readonly string[], global: MigrationState, workspace: MigrationState): Promise<void> {
  const data = parseIdentityMigration(text, roots);
  assertMigrationNoConflicts(data, global, workspace);
  const pending = workspace.get<string>(MIGRATION_PENDING_KEY);
  if (pending !== undefined && pending !== text) throw new Error('已有待应用的迁移，请先重载完成，不覆盖迁移记录。');
  await workspace.update(MIGRATION_PENDING_KEY, text);
}

export async function applyPendingIdentityMigration(roots: readonly string[], global: MigrationState, workspace: MigrationState): Promise<boolean> {
  const pending = workspace.get<string>(MIGRATION_PENDING_KEY);
  if (pending === undefined) return false;
  const data = parseIdentityMigration(pending, roots);
  assertMigrationNoConflicts(data, global, workspace);
  for (const [incoming, state] of [[data.global, global], [data.workspace, workspace]] as const) {
    for (const [key, value] of Object.entries(incoming)) {
      // 再次确认，异步写入期间出现新值也不能覆盖；失败留下暂存数据供重试。
      assertMigrationNoConflicts(data, global, workspace);
      if (state.get(key) === undefined) await state.update(key, value);
    }
  }
  await workspace.update(MIGRATION_PENDING_KEY, undefined);
  return true;
}
