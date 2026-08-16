export type ActiveTabKind = 'movableText' | 'blockedText' | 'auxiliary' | 'none';

export interface PendingGroupSnapshot {
  readonly fullReconcile: boolean;
  readonly textTabIds: readonly string[];
  readonly auxiliaryTabIds: readonly string[];
}

export type PendingGroupAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'reconcileAll' }
  | { readonly kind: 'placeTextTabs'; readonly tabIds: readonly string[] }
  | { readonly kind: 'placeAuxiliaryTab'; readonly tabId: string };

export function choosePendingGroupAction(
  pending: PendingGroupSnapshot,
  activeTabId: string | undefined,
  activeTabKind: ActiveTabKind,
): PendingGroupAction {
  if (activeTabKind === 'auxiliary'
    && activeTabId !== undefined
    && pending.auxiliaryTabIds.includes(activeTabId)) {
    return { kind: 'placeAuxiliaryTab', tabId: activeTabId };
  }

  if (pending.fullReconcile
    && (activeTabKind === 'movableText' || activeTabKind === 'blockedText')) {
    return { kind: 'reconcileAll' };
  }

  if (activeTabKind !== 'movableText') {
    return hasPendingWork(pending) ? { kind: 'wait' } : { kind: 'none' };
  }
  if (pending.textTabIds.length > 0) {
    return { kind: 'placeTextTabs', tabIds: pending.textTabIds };
  }
  return { kind: 'none' };
}

function hasPendingWork(pending: PendingGroupSnapshot): boolean {
  return pending.fullReconcile
    || pending.textTabIds.length > 0
    || pending.auxiliaryTabIds.length > 0;
}
