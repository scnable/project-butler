export interface GroupableTab {
  readonly id: string;
  readonly category: 'project' | 'external';
}

/**
 * 稳定地把非项目标签移到末尾。项目标签之间、非项目标签之间的相对顺序均不改变。
 */
export function moveNonProjectTabsToTail(tabs: readonly GroupableTab[]): string[] {
  const project = tabs.filter((tab) => tab.category === 'project');
  const tail = tabs.filter((tab) => tab.category === 'external');
  return [...project, ...tail].map((tab) => tab.id);
}

export function isSameOrder(current: readonly string[], target: readonly string[]): boolean {
  return current.length === target.length && current.every((id, index) => id === target[index]);
}
