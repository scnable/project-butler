export const DEFAULT_TODO_EXCLUDE_PATTERNS = [
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/node_modules/**',
  '**/bower_components/**',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/coverage/**',
  '**/.vscode-test/**',
] as const;

export function collectTodoExcludePatterns(...configurations: readonly unknown[]): string[] {
  const patterns = new Set<string>(DEFAULT_TODO_EXCLUDE_PATTERNS);
  for (const configuration of configurations) {
    if (!isRecord(configuration)) continue;
    for (const [rawPattern, value] of Object.entries(configuration)) {
      if (value !== true) continue;
      const pattern = normalizePattern(rawPattern);
      if (pattern.length === 0) continue;
      patterns.add(pattern);
      if (!pattern.endsWith('/**')) patterns.add(`${pattern}/**`);
    }
  }
  return [...patterns];
}

export function createTodoExcludeGlob(...configurations: readonly unknown[]): string {
  const patterns = collectTodoExcludePatterns(...configurations);
  if (patterns.length === 1) return patterns[0] ?? '';
  return `{${patterns.join(',')}}`;
}

export function createTodoSearchTerms(tagNames: readonly string[], markdownTasks: boolean): string[] {
  const terms = new Set(tagNames.map((tag) => tag.trim()).filter((tag) => tag.length > 0));
  if (markdownTasks) terms.add('[ ]');
  return [...terms];
}

export function normalizeTodoCandidatePath(path: string): string | undefined {
  const normalized = path.trim().replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return undefined;
  if (normalized.split('/').some((segment) => segment === '..')) return undefined;
  return normalized;
}

export function parseTodoCandidatePathOutput(output: Buffer): string[] {
  const unique = new Set<string>();
  for (const raw of output.toString('utf8').split('\0')) {
    const normalized = normalizeTodoCandidatePath(raw);
    if (normalized !== undefined) unique.add(normalized);
  }
  return [...unique];
}

function normalizePattern(pattern: string): string {
  return pattern.trim().replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
