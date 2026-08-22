import { TodoSeverity, TodoTagDefinition } from './todoTypes';

export const DEFAULT_TODO_TAG_NAMES = ['TODO', 'FIXME', 'BUG', 'HACK', 'XXX'] as const;
export const OPTIONAL_TODO_TAG_NAMES = ['DEBUG', 'NOTE', 'OPTIMIZE', 'REVIEW'] as const;

const TAG_NAME_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

const PRESET_METADATA: Readonly<Record<string, { readonly severity: TodoSeverity; readonly icon: TodoTagDefinition['icon'] }>> = {
  TODO: { severity: 'normal', icon: 'check' },
  FIXME: { severity: 'important', icon: 'error' },
  BUG: { severity: 'important', icon: 'error' },
  HACK: { severity: 'attention', icon: 'warning' },
  XXX: { severity: 'attention', icon: 'warning' },
  DEBUG: { severity: 'attention', icon: 'warning' },
  NOTE: { severity: 'info', icon: 'info' },
  OPTIMIZE: { severity: 'normal', icon: 'check' },
  REVIEW: { severity: 'attention', icon: 'warning' },
};

export function normalizeTodoTagName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLocaleUpperCase();
  return TAG_NAME_PATTERN.test(normalized) ? normalized : undefined;
}
export function normalizeTodoTagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_TODO_TAG_NAMES];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const normalized = normalizeTodoTagName(candidate);
    if (normalized !== undefined && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result.length === 0 ? [...DEFAULT_TODO_TAG_NAMES] : result;
}

export function createTodoTagDefinitions(names: readonly string[]): TodoTagDefinition[] {
  const enabled = new Set(normalizeTodoTagNames(names));
  return [...enabled].map((name) => {
    const metadata = PRESET_METADATA[name] ?? { severity: 'normal' as const, icon: 'check' as const };
    return { name, label: name, enabled: true, ...metadata };
  });
}

export function getAllTodoTagChoices(current: readonly string[]): TodoTagDefinition[] {
  const normalizedCurrent = normalizeTodoTagNames(current);
  const names = [...DEFAULT_TODO_TAG_NAMES, ...OPTIONAL_TODO_TAG_NAMES, ...normalizedCurrent];
  const unique = [...new Set(names)];
  const enabled = new Set(normalizedCurrent);
  return unique.map((name) => {
    const metadata = PRESET_METADATA[name] ?? { severity: 'normal' as const, icon: 'check' as const };
    return { name, label: name, enabled: enabled.has(name), ...metadata };
  });
}
