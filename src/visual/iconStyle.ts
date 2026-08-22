export const ICON_STYLES = ['unified', 'native'] as const;

export type IconStyle = typeof ICON_STYLES[number];

export function normalizeIconStyle(value: unknown): IconStyle {
  return value === 'native' ? 'native' : 'unified';
}
