export interface MarkerLocation {
  readonly tag: string;
  readonly tagStart: number;
  readonly tagEnd: number;
  readonly owner?: string;
  readonly ownerRange?: { readonly start: number; readonly end: number };
  readonly ownerSyntaxRange?: { readonly start: number; readonly end: number };
  readonly qualifierEnd: number;
  readonly syntaxEnd: number;
  readonly completedRange?: { readonly start: number; readonly end: number };
}

export function findMarker(line: string, tags: readonly string[]): MarkerLocation | undefined {
  const escaped = tags.map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  if (escaped.length === 0) return undefined;
  const pattern = new RegExp(`(?:\\/\\/|#|--|;|\\/\\*|<!--)\\s*(${escaped.join('|')})(\\s*\\(\\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,31})\\s*\\))?(\\s*\\[[ xX]\\])?(\\s*:\\s*)?`, 'i');
  const result = pattern.exec(line);
  if (result === null || result.index < 0 || result[1] === undefined) return undefined;
  const full = result[0];
  const relativeTagStart = full.toLocaleLowerCase().lastIndexOf(result[1].toLocaleLowerCase());
  const tagStart = result.index + relativeTagStart;
  const ownerSyntaxText = result[2];
  const owner = result[3];
  const ownerSyntaxStart = ownerSyntaxText === undefined ? undefined : full.indexOf(ownerSyntaxText, relativeTagStart + result[1].length);
  const ownerStart = owner === undefined ? undefined : full.indexOf(owner, relativeTagStart + result[1].length);
  const completedText = result[4];
  const completedStart = completedText === undefined ? undefined : full.indexOf(completedText, relativeTagStart + result[1].length);
  const completedRange = completedText === undefined
    ? undefined
    : { start: result.index + (completedStart ?? 0), end: result.index + (completedStart ?? 0) + completedText.length };
  const ownerSyntaxRange = ownerSyntaxText === undefined || ownerSyntaxStart === undefined
    ? undefined
    : { start: result.index + ownerSyntaxStart, end: result.index + ownerSyntaxStart + ownerSyntaxText.length };
  return {
    tag: result[1].toLocaleUpperCase(), tagStart, tagEnd: tagStart + result[1].length,
    ...(owner === undefined ? {} : { owner }),
    ...(owner === undefined || ownerStart === undefined ? {} : {
      ownerRange: { start: result.index + ownerStart, end: result.index + ownerStart + owner.length },
    }),
    ...(ownerSyntaxRange === undefined ? {} : { ownerSyntaxRange }),
    qualifierEnd: ownerSyntaxRange?.end ?? tagStart + result[1].length,
    syntaxEnd: result.index + full.length,
    ...(completedRange === undefined ? {} : { completedRange }),
  };
}
