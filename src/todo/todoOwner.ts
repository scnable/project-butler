const TODO_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/u;

export function normalizeTodoOwner(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return TODO_OWNER_PATTERN.test(normalized) ? normalized : undefined;
}

export function normalizeTodoOwners(primary: unknown, aliases: unknown): string[] {
  const values = [primary, ...(Array.isArray(aliases) ? aliases : [])]
    .map(normalizeTodoOwner)
    .filter((value): value is string => value !== undefined);
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isMyTodoOwner(owner: string | undefined, identities: readonly string[]): boolean {
  if (owner === undefined) return false;
  const key = owner.toLocaleLowerCase();
  return identities.some((identity) => identity.toLocaleLowerCase() === key);
}
