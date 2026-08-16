export type OutlineScope = 'functions' | 'functionsAndTypes' | 'all';
export type OutlineHierarchy = 'tree' | 'flat';
export type OutlineSort = 'source' | 'name' | 'typeName';

export interface OutlinePosition {
  line: number;
  character: number;
}

export interface OutlineRange {
  start: OutlinePosition;
  end: OutlinePosition;
}

export interface OutlineSymbol {
  id: string;
  editKey: string;
  name: string;
  detail: string;
  containerName: string;
  parentPath: string;
  kind: string;
  range: OutlineRange;
  selectionRange: OutlineRange;
  span: number;
  isLong: boolean;
  isEdited: boolean;
  isContext: boolean;
  children: OutlineSymbol[];
}

export interface OutlineProjectionOptions {
  scope: OutlineScope;
  hierarchy: OutlineHierarchy;
  sort: OutlineSort;
  query: string;
  locale: string;
}

const FUNCTION_KINDS = new Set(['Function', 'Method', 'Constructor']);
const TYPE_KINDS = new Set([
  'Class',
  'Interface',
  'Struct',
  'Namespace',
  'Module',
  'Enum',
  'TypeParameter',
]);
const DEFAULT_SCOPE_EXTRA_KINDS = new Set(['MacroDefinition']);

const KIND_ORDER = [
  'Namespace',
  'Module',
  'Class',
  'Interface',
  'Struct',
  'Enum',
  'Constructor',
  'Function',
  'Method',
  'Property',
  'Field',
  'Constant',
  'Variable',
  'EnumMember',
  'Event',
  'Operator',
  'MacroDefinition',
];

const KIND_ORDER_MAP = new Map(KIND_ORDER.map((kind, index) => [kind, index]));

export function isFunctionKind(kind: string): boolean {
  return FUNCTION_KINDS.has(kind);
}

export function isTypeKind(kind: string): boolean {
  return TYPE_KINDS.has(kind);
}

export function createSymbolId(
  documentKey: string,
  kind: string,
  name: string,
  parentPath: string,
  position: OutlinePosition,
): string {
  return `${documentKey}|${parentPath}|${kind}|${name}|${position.line}:${position.character}`;
}

export function createEditKey(kind: string, name: string, parentPath: string): string {
  return `${parentPath}|${kind}|${name}`;
}

export function applyFunctionMetrics(symbols: readonly OutlineSymbol[]): OutlineSymbol[] {
  const functions = flattenSymbols(symbols).filter((symbol) => isFunctionKind(symbol.kind));
  const average = functions.length === 0
    ? undefined
    : functions.reduce((sum, symbol) => sum + symbol.span, 0) / functions.length;

  const visit = (symbol: OutlineSymbol): OutlineSymbol => ({
    ...symbol,
    isLong: average !== undefined && isFunctionKind(symbol.kind) && symbol.span > average,
    children: symbol.children.map(visit),
  });

  return symbols.map(visit);
}

export function projectSymbols(
  symbols: readonly OutlineSymbol[],
  options: OutlineProjectionOptions,
): OutlineSymbol[] {
  const query = options.query.trim().toLocaleLowerCase(options.locale);
  const compare = createComparator(options.sort, options.locale);

  if (options.hierarchy === 'flat') {
    return flattenSymbols(symbols)
      .filter((symbol) => isAllowedByScope(symbol, options.scope))
      .filter((symbol) => query.length === 0 || matchesQuery(symbol, query, options.locale))
      .map((symbol) => ({ ...symbol, isContext: false, children: [] }))
      .sort(compare);
  }

  const visit = (symbol: OutlineSymbol): OutlineSymbol | undefined => {
    const allowed = isAllowedByScope(symbol, options.scope);
    const selfMatches = query.length === 0 || matchesQuery(symbol, query, options.locale);
    const children = symbol.children
      .map(visit)
      .filter((child): child is OutlineSymbol => child !== undefined)
      .sort(compare);

    if (allowed && selfMatches) {
      const visibleChildren = query.length > 0
        ? projectDescendantsWithoutQuery(symbol.children, options.scope, compare)
        : children;
      return { ...symbol, isContext: false, children: visibleChildren };
    }

    if (children.length > 0) {
      return { ...symbol, isContext: !allowed || !selfMatches, children };
    }

    return undefined;
  };

  return symbols
    .map(visit)
    .filter((symbol): symbol is OutlineSymbol => symbol !== undefined)
    .sort(compare);
}

export function flattenSymbols(symbols: readonly OutlineSymbol[]): OutlineSymbol[] {
  const flattened: OutlineSymbol[] = [];
  const visit = (symbol: OutlineSymbol): void => {
    flattened.push(symbol);
    symbol.children.forEach(visit);
  };
  symbols.forEach(visit);
  return flattened;
}

export function countSymbols(symbols: readonly OutlineSymbol[]): number {
  return flattenSymbols(symbols).length;
}

export function findCurrentSymbol(
  symbols: readonly OutlineSymbol[],
  position: OutlinePosition,
): OutlineSymbol | undefined {
  const candidates = flattenSymbols(symbols).filter((symbol) => contains(symbol.range, position));
  const functions = candidates.filter((symbol) => isFunctionKind(symbol.kind));
  const types = candidates.filter((symbol) => isTypeKind(symbol.kind));
  const preferred = functions.length > 0 ? functions : types.length > 0 ? types : candidates;
  preferred.sort((left, right) => {
    const spanDifference = rangeSize(left.range) - rangeSize(right.range);
    if (spanDifference !== 0) {
      return spanDifference;
    }
    return right.parentPath.length - left.parentPath.length;
  });
  return preferred[0];
}

function projectDescendantsWithoutQuery(
  symbols: readonly OutlineSymbol[],
  scope: OutlineScope,
  compare: (left: OutlineSymbol, right: OutlineSymbol) => number,
): OutlineSymbol[] {
  const visit = (symbol: OutlineSymbol): OutlineSymbol | undefined => {
    const children = symbol.children
      .map(visit)
      .filter((child): child is OutlineSymbol => child !== undefined)
      .sort(compare);
    if (isAllowedByScope(symbol, scope)) {
      return { ...symbol, isContext: false, children };
    }
    return children.length > 0 ? { ...symbol, isContext: true, children } : undefined;
  };

  return symbols
    .map(visit)
    .filter((symbol): symbol is OutlineSymbol => symbol !== undefined)
    .sort(compare);
}

function isAllowedByScope(symbol: OutlineSymbol, scope: OutlineScope): boolean {
  if (scope === 'all') {
    return true;
  }
  if (scope === 'functions') {
    return isFunctionKind(symbol.kind);
  }
  return isFunctionKind(symbol.kind)
    || isTypeKind(symbol.kind)
    || DEFAULT_SCOPE_EXTRA_KINDS.has(symbol.kind);
}

function matchesQuery(symbol: OutlineSymbol, query: string, locale: string): boolean {
  return [symbol.name, symbol.detail, symbol.containerName, symbol.parentPath]
    .some((value) => value.toLocaleLowerCase(locale).includes(query));
}

function createComparator(
  sort: OutlineSort,
  locale: string,
): (left: OutlineSymbol, right: OutlineSymbol) => number {
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  const source = (left: OutlineSymbol, right: OutlineSymbol): number => {
    const lineDifference = left.selectionRange.start.line - right.selectionRange.start.line;
    return lineDifference !== 0
      ? lineDifference
      : left.selectionRange.start.character - right.selectionRange.start.character;
  };

  if (sort === 'source') {
    return source;
  }

  if (sort === 'name') {
    return (left, right) => collator.compare(left.name, right.name) || source(left, right);
  }

  return (left, right) => {
    const leftOrder = KIND_ORDER_MAP.get(left.kind) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = KIND_ORDER_MAP.get(right.kind) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder
      || collator.compare(left.kind, right.kind)
      || collator.compare(left.name, right.name)
      || source(left, right);
  };
}

function contains(range: OutlineRange, position: OutlinePosition): boolean {
  return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

function comparePosition(left: OutlinePosition, right: OutlinePosition): number {
  return left.line - right.line || left.character - right.character;
}

function rangeSize(range: OutlineRange): number {
  return (range.end.line - range.start.line) * 1_000_000
    + range.end.character - range.start.character;
}
