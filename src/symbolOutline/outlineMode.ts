export type OutlineMode = 'native' | 'enhanced' | 'both';
export type NativeOutlineConflictChoice = 'both' | 'native' | undefined;

export function resolveNativeOutlineConflict(choice: NativeOutlineConflictChoice): OutlineMode {
  return choice === 'both' ? 'both' : 'native';
}

export function isEnhancedOutlineEnabled(mode: OutlineMode): boolean {
  return mode === 'enhanced' || mode === 'both';
}

export function shouldShowNativeOutlineNotice(mode: OutlineMode): boolean {
  return mode === 'enhanced';
}

export function isNativeOutlineNoticeVisible(mode: OutlineMode): boolean {
  return shouldShowNativeOutlineNotice(mode);
}
