export const TODO_DESCRIPTION_MAX_LENGTH = 30;
export const EMPTY_TODO_DESCRIPTION = '未填写描述';

export function normalizeTodoDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0 || [...normalized].length > TODO_DESCRIPTION_MAX_LENGTH) return undefined;
  return normalized;
}

export function todoDescriptionInputValue(value: string): string {
  return [...value.replace(/\s+/g, ' ').trim()].slice(0, TODO_DESCRIPTION_MAX_LENGTH).join('');
}

export function formatTodoDescription(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return EMPTY_TODO_DESCRIPTION;
  const characters = [...normalized];
  if (characters.length <= TODO_DESCRIPTION_MAX_LENGTH) return normalized;
  return `${characters.slice(0, TODO_DESCRIPTION_MAX_LENGTH - 1).join('')}…`;
}

export function collectSelectableTodoDescriptions(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeTodoDescription).filter((value): value is string => value !== undefined))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true }));
}

export function todoDescriptionGroupKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
