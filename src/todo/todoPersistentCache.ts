import { TodoMatch } from './todoTypes';

/** 工作区私有缓存：无 VS Code 依赖，输入校验必须先于索引恢复和任何文件访问。 */
export const TODO_CACHE_KEY = 'projectManager.todo.diskCache.v1';
export const TODO_CACHE_MAX_FILES = 50_000;
export const TODO_CACHE_MAX_BYTES = 8 * 1024 * 1024;
export const TODO_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
export interface TodoFileStamp { readonly mtime: number; readonly ctime: number; readonly size: number }
export interface TodoCachedFile extends TodoFileStamp {
  readonly uri: string;
  readonly matches: readonly TodoMatch[];
}
export interface TodoDiskCache {
  readonly version: 1;
  readonly signature: string;
  readonly savedAt: number;
  readonly fullAt: number;
  readonly files: readonly TodoCachedFile[];
}

export function sameTodoFileStamp(a: TodoFileStamp, b: TodoFileStamp): boolean {
  return a.mtime === b.mtime && a.ctime === b.ctime && a.size === b.size;
}

export function encodeTodoCache(cache: TodoDiskCache): string | undefined {
  if (cache.files.length > TODO_CACHE_MAX_FILES) return undefined;
  let estimate = cache.signature.length * 2 + 256;
  let count = 0;
  for (const file of cache.files) {
    estimate += file.uri.length * 2 + 160;
    count += file.matches.length;
    if (count > 10_000) return undefined;
    for (const match of file.matches) {
      if (!validMatch(match)) return undefined;
      estimate += match.text.length * 6 + 512;
    }
    if (estimate > TODO_CACHE_MAX_BYTES) return undefined;
  }
  const text = JSON.stringify(cache);
  return Buffer.byteLength(text, 'utf8') <= TODO_CACHE_MAX_BYTES ? text : undefined;
}

export function decodeTodoCache(
  raw: unknown, signature: string, isAllowedUri: (uri: string) => boolean, now = Date.now(),
): TodoDiskCache | undefined {
  if (typeof raw !== 'string' || raw.length > TODO_CACHE_MAX_BYTES
    || Buffer.byteLength(raw, 'utf8') > TODO_CACHE_MAX_BYTES) return undefined;
  try {
    const cache: unknown = JSON.parse(raw);
    if (!record(cache) || cache.version !== 1 || cache.signature !== signature
      || !number(cache.savedAt) || !number(cache.fullAt) || cache.savedAt > now || cache.fullAt > now
      || now - cache.fullAt > TODO_CACHE_MAX_AGE
      || !Array.isArray(cache.files) || cache.files.length > TODO_CACHE_MAX_FILES) return undefined;
    let matches = 0;
    const seen = new Set<string>();
    for (const file of cache.files) {
      if (!record(file) || typeof file.uri !== 'string' || file.uri.length > 8192
        || !isAllowedUri(file.uri) || seen.has(file.uri)
        || !number(file.mtime) || !number(file.ctime) || !number(file.size)
        || !Array.isArray(file.matches)) return undefined;
      seen.add(file.uri);
      matches += file.matches.length;
      if (matches > 10_000 || !file.matches.every(validMatch)) return undefined;
    }
    return cache as unknown as TodoDiskCache;
  } catch { return undefined; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function validMatch(value: unknown): boolean {
  return record(value) && typeof value.tag === 'string' && value.tag.length <= 32
    && typeof value.rawTag === 'string' && value.rawTag.length <= 32
    && (value.owner === undefined || typeof value.owner === 'string' && value.owner.length <= 32)
    && typeof value.text === 'string' && value.text.length <= 16384
    && number(value.line) && number(value.startCharacter) && number(value.endCharacter)
    && value.endCharacter >= value.startCharacter && typeof value.completed === 'boolean'
    && (value.source === 'comment' || value.source === 'markdownTask');
}
