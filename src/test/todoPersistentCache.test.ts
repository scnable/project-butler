import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { decodeTodoCache, encodeTodoCache, sameTodoFileStamp, TODO_CACHE_MAX_AGE, TodoDiskCache } from '../todo/todoPersistentCache';

const now = 100_000_000;
const cache: TodoDiskCache = { version: 1, signature: 'scope', savedAt: now, fullAt: now,
  files: [{ uri: 'file:///workspace/a.ts', mtime: 1, ctime: 1, size: 10,
    matches: [{ tag: 'TODO', rawTag: 'TODO', owner: 'me', text: '处理设置',
      line: 0, startCharacter: 3, endCharacter: 7, completed: false, source: 'comment' }] }] };
const allowed = (uri: string): boolean => uri.startsWith('file:///workspace/');

test('TODO 缓存可往返，保留零标记文件与位置，但不包含源码全文', () => {
  const value = { ...cache, files: [...cache.files, { uri: 'file:///workspace/b.ts', mtime: 1, ctime: 1, size: 0, matches: [] }] };
  assert.deepEqual(decodeTodoCache(encodeTodoCache(value), 'scope', allowed, now), value);
  assert.equal(encodeTodoCache(value)?.includes('sourceText'), false);
});
test('TODO 缓存拒绝损坏、未来版本、范围变化和过期内容', () => {
  assert.equal(decodeTodoCache('{', 'scope', allowed, now), undefined);
  assert.equal(decodeTodoCache(JSON.stringify({ ...cache, version: 2 }), 'scope', allowed, now), undefined);
  assert.equal(decodeTodoCache(encodeTodoCache(cache), 'different', allowed, now), undefined);
  assert.equal(decodeTodoCache(encodeTodoCache(cache), 'scope', allowed, now + TODO_CACHE_MAX_AGE + 1), undefined);
});
test('TODO 缓存拒绝越界资源、重复文件及非法位置', () => {
  assert.equal(decodeTodoCache(encodeTodoCache(cache), 'scope', () => false, now), undefined);
  assert.equal(decodeTodoCache(JSON.stringify({ ...cache, files: [...cache.files, ...cache.files] }), 'scope', allowed, now), undefined);
  const file = cache.files[0]!;
  assert.equal(decodeTodoCache(JSON.stringify({ ...cache, files: [{ ...file, matches: [{ ...file.matches[0], line: -1 }] }] }), 'scope', allowed, now), undefined);
});
test('TODO 缓存写入前限制单条长度与条目数量', () => {
  const file = cache.files[0]!;
  assert.equal(encodeTodoCache({ ...cache, files: [{ ...file, matches: [{ ...file.matches[0]!, text: 'x'.repeat(16385) }] }] }), undefined);
  assert.equal(encodeTodoCache({ ...cache, files: Array(50_001).fill(file) }), undefined);
});
test('TODO 文件状态同时比较修改时间、创建时间和大小', () => {
  const stamp = { mtime: 1, ctime: 2, size: 3 };
  assert.equal(sameTodoFileStamp(stamp, { ...stamp }), true);
  for (const key of ['mtime', 'ctime', 'size'] as const) assert.equal(sameTodoFileStamp(stamp, { ...stamp, [key]: 9 }), false);
});
