export interface GroupableTab {
  readonly id: string;
  readonly category: 'project' | 'external';
}

export type SingleTabPlacement =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'move'; readonly targetIndex: number }
  | { readonly kind: 'reconcile' };

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

/**
 * 为一个新打开的标签计算快速放置方案。
 *
 * 只有在其余标签已经满足稳定分区时才允许单次移动；否则回退到完整整理，
 * 避免单标签优化掩盖或扩大既有的历史乱序。
 */
export function planSingleTabPlacement(
  tabs: readonly GroupableTab[],
  tabId: string,
): SingleTabPlacement {
  const currentOrder = tabs.map((tab) => tab.id);
  const currentIndex = currentOrder.indexOf(tabId);
  if (currentIndex < 0) {
    return { kind: 'missing' };
  }

  const targetOrder = moveNonProjectTabsToTail(tabs);
  const targetIndex = targetOrder.indexOf(tabId);
  const currentWithoutTarget = currentOrder.filter((id) => id !== tabId);
  const targetWithoutTarget = targetOrder.filter((id) => id !== tabId);
  if (!isSameOrder(currentWithoutTarget, targetWithoutTarget)) {
    return { kind: 'reconcile' };
  }
  if (currentIndex === targetIndex) {
    return { kind: 'unchanged' };
  }
  return { kind: 'move', targetIndex };
}
