const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatTodoFreshness(lastSuccessfulUpdate: number | undefined, now = Date.now()): string {
  if (lastSuccessfulUpdate === undefined) return '尚未完整更新';
  const elapsed = Math.max(0, now - lastSuccessfulUpdate);
  if (elapsed < MINUTE_MS) return '刚刚更新';
  if (elapsed < HOUR_MS) return `上次完整更新 ${Math.floor(elapsed / MINUTE_MS)} 分钟前`;
  if (elapsed < DAY_MS) return `上次完整更新 ${Math.floor(elapsed / HOUR_MS)} 小时前`;
  return `上次完整更新 ${Math.floor(elapsed / DAY_MS)} 天前`;
}

export function todoUpdateAgeDays(lastSuccessfulUpdate: number | undefined, now = Date.now()): number | undefined {
  if (lastSuccessfulUpdate === undefined) return undefined;
  return Math.floor(Math.max(0, now - lastSuccessfulUpdate) / DAY_MS);
}
