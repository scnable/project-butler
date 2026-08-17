import {
  createEditKey,
  createSymbolId,
  OutlineRange,
  OutlineSymbol,
} from './symbolModel';

interface ParsedBranch {
  readonly directive: string;
  readonly summary: string;
  readonly startLine: number;
  endLine?: number;
  readonly regions: ParsedRegion[];
}

interface ParsedRegion {
  readonly directive: string;
  readonly summary: string;
  readonly startLine: number;
  endLine?: number;
  readonly branches: ParsedBranch[];
  currentBranch: ParsedBranch;
}

const C_FAMILY_LANGUAGE_IDS = new Set([
  'c',
  'cpp',
  'cuda-cpp',
  'objective-c',
  'objective-cpp',
]);

const STRUCT_ALIAS_KINDS = new Set(['Variable', 'TypeParameter', 'Class']);

export function enhanceOutlineSymbols(
  symbols: readonly OutlineSymbol[],
  source: string,
  languageId: string,
  documentKey: string,
): OutlineSymbol[] {
  const deduplicated = mergeDuplicateStructSymbols(symbols);
  if (!C_FAMILY_LANGUAGE_IDS.has(languageId)) {
    return deduplicated;
  }
  const regions = createPreprocessorSymbols(source, documentKey);
  const macros = createMacroSymbols(source, documentKey);
  const withoutMacroAliases = removeMacroAliases(deduplicated, macros);
  return simplifyPreprocessorRegions(mergeOutlineLevels([...withoutMacroAliases, ...macros], regions));
}

export function createMacroSymbols(source: string, documentKey: string): OutlineSymbol[] {
  const lines = source.split(/\r?\n/);
  const macros: OutlineSymbol[] = [];
  let inBlockComment = false;

  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line] ?? '';
    let commentScan = stripCommentsForDirective(text, inBlockComment);
    inBlockComment = commentScan.inBlockComment;
    const match = /^\s*#\s*define\s+([A-Za-z_]\w*)(\(([^)]*)\))?(?:\s+(.*))?$/.exec(commentScan.text);
    if (match === null) {
      continue;
    }

    const name = match[1] ?? '';
    const parameters = match[2] ?? '';
    const startLine = line;
    let endLine = line;
    while (endsWithContinuation(commentScan.text) && endLine + 1 < lines.length) {
      endLine += 1;
      commentScan = stripCommentsForDirective(lines[endLine] ?? '', inBlockComment);
      inBlockComment = commentScan.inBlockComment;
    }

    const nameCharacter = Math.max(0, text.indexOf(name));
    const range = lineRange(startLine, endLine, lines);
    macros.push(createSyntheticSymbol(
      documentKey,
      name,
      'MacroDefinition',
      range,
      '',
      [],
      parameters.replace(/\s+/g, ' '),
      false,
      {
        start: { line: startLine, character: nameCharacter },
        end: { line: startLine, character: nameCharacter + name.length },
      },
    ));
    line = endLine;
  }

  return macros;
}

export function createPreprocessorSymbols(source: string, documentKey: string): OutlineSymbol[] {
  const lines = source.split(/\r?\n/);
  const roots: ParsedRegion[] = [];
  const stack: ParsedRegion[] = [];
  let inBlockComment = false;

  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line] ?? '';
    const commentScan = stripCommentsForDirective(text, inBlockComment);
    inBlockComment = commentScan.inBlockComment;
    if (!/^\s*#/.test(commentScan.text)) {
      continue;
    }
    const match = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/.exec(text);
    if (match === null) {
      continue;
    }
    const directive = match[1] ?? '';
    const summary = normalizeDirectiveSummary(match[2] ?? '');

    if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef') {
      const branch: ParsedBranch = {
        directive,
        summary,
        startLine: line,
        regions: [],
      };
      const region: ParsedRegion = {
        directive,
        summary,
        startLine: line,
        branches: [branch],
        currentBranch: branch,
      };
      const parent = stack.at(-1);
      if (parent === undefined) {
        roots.push(region);
      } else {
        parent.currentBranch.regions.push(region);
      }
      stack.push(region);
      continue;
    }

    const current = stack.at(-1);
    if (current === undefined) {
      continue;
    }

    if (directive === 'elif' || directive === 'else') {
      current.currentBranch.endLine = Math.max(current.currentBranch.startLine, line - 1);
      const branch: ParsedBranch = {
        directive,
        summary,
        startLine: line,
        regions: [],
      };
      current.branches.push(branch);
      current.currentBranch = branch;
      continue;
    }

    current.currentBranch.endLine = line;
    current.endLine = line;
    stack.pop();
  }

  return roots
    .map((region) => convertCompletedRegion(region, lines, documentKey, ''))
    .filter((region): region is OutlineSymbol => region !== undefined);
}

export function mergeDuplicateStructSymbols(symbols: readonly OutlineSymbol[]): OutlineSymbol[] {
  const recursivelyNormalized = symbols.map((symbol) => ({
    ...symbol,
    children: mergeDuplicateStructSymbols(symbol.children),
  }));
  const result: OutlineSymbol[] = [];

  for (const candidate of recursivelyNormalized) {
    const duplicateIndex = result.findIndex((existing) => isProvenStructDuplicate(existing, candidate));
    if (duplicateIndex < 0) {
      result.push(candidate);
      continue;
    }
    const existing = result[duplicateIndex];
    if (existing === undefined) {
      result.push(candidate);
      continue;
    }
    result[duplicateIndex] = mergeStructPair(existing, candidate);
  }

  return result;
}

function convertCompletedRegion(
  region: ParsedRegion,
  lines: readonly string[],
  documentKey: string,
  parentPath: string,
): OutlineSymbol | undefined {
  if (region.endLine === undefined) {
    return undefined;
  }
  const regionName = formatDirective(region.directive, region.summary);
  const regionPath = parentPath.length === 0 ? regionName : `${parentPath} › ${regionName}`;
  const range = lineRange(region.startLine, region.endLine, lines);
  const branches = region.branches
    .map((branch) => convertCompletedBranch(branch, lines, documentKey, regionPath))
    .filter((branch): branch is OutlineSymbol => branch !== undefined);
  return createSyntheticSymbol(documentKey, regionName, 'PreprocessorRegion', range, parentPath, branches);
}

function convertCompletedBranch(
  branch: ParsedBranch,
  lines: readonly string[],
  documentKey: string,
  parentPath: string,
): OutlineSymbol | undefined {
  if (branch.endLine === undefined) {
    return undefined;
  }
  const name = formatDirective(branch.directive, branch.summary);
  const branchPath = `${parentPath} › ${name}`;
  const children = branch.regions
    .map((region) => convertCompletedRegion(region, lines, documentKey, branchPath))
    .filter((region): region is OutlineSymbol => region !== undefined);
  return createSyntheticSymbol(
    documentKey,
    name,
    'PreprocessorBranch',
    lineRange(branch.startLine, branch.endLine, lines),
    parentPath,
    children,
  );
}

function createSyntheticSymbol(
  documentKey: string,
  name: string,
  kind: string,
  range: OutlineRange,
  parentPath: string,
  children: OutlineSymbol[],
  detail = '',
  isContext = true,
  selectionRange?: OutlineRange,
): OutlineSymbol {
  return {
    id: createSymbolId(documentKey, kind, name, parentPath, range.start),
    editKey: createEditKey(kind, name, parentPath),
    name,
    detail,
    containerName: parentPath,
    parentPath,
    kind,
    range,
    selectionRange: selectionRange ?? {
      start: range.start,
      end: { line: range.start.line, character: Math.max(range.start.character + 1, range.end.character) },
    },
    span: Math.max(1, range.end.line - range.start.line + 1),
    isLong: false,
    isEdited: false,
    isContext,
    children,
  };
}

function removeMacroAliases(
  symbols: readonly OutlineSymbol[],
  macros: readonly OutlineSymbol[],
): OutlineSymbol[] {
  const macroKeys = new Set(macros.map((macro) => macroAliasKey(
    macro.name,
    macro.selectionRange.start.line,
  )));
  const visit = (symbol: OutlineSymbol): OutlineSymbol | undefined => {
    const children = symbol.children
      .map(visit)
      .filter((child): child is OutlineSymbol => child !== undefined);
    const canBeMacroAlias = ['Constant', 'Variable', 'Function'].includes(symbol.kind);
    if (canBeMacroAlias && macroKeys.has(macroAliasKey(
      normalizeProviderMacroName(symbol.name),
      symbol.selectionRange.start.line,
    ))) {
      return undefined;
    }
    return { ...symbol, children };
  };
  return symbols
    .map(visit)
    .filter((symbol): symbol is OutlineSymbol => symbol !== undefined);
}

function normalizeProviderMacroName(name: string): string {
  return name.replace(/\s*\(.*$/s, '').trim();
}

function macroAliasKey(name: string, line: number): string {
  return `${line}:${name}`;
}

function endsWithContinuation(value: string): boolean {
  return /\\\s*$/.test(value);
}

function mergeOutlineLevels(
  sourceSymbols: readonly OutlineSymbol[],
  regionSymbols: readonly OutlineSymbol[],
): OutlineSymbol[] {
  const remainingRegions = [...regionSymbols];
  const sourceWithInnerRegions = sourceSymbols.map((symbol) => {
    const contained = remainingRegions.filter((region) => containsRange(symbol.range, region.range));
    for (const region of contained) {
      const index = remainingRegions.indexOf(region);
      if (index >= 0) {
        remainingRegions.splice(index, 1);
      }
    }
    return {
      ...symbol,
      children: mergeOutlineLevels(symbol.children, contained),
    };
  });

  const unassignedSymbols = [...sourceWithInnerRegions];
  const populatedRegions = remainingRegions.map((region) => {
    const assigned = unassignedSymbols.filter((symbol) => containsRange(region.range, symbol.range));
    for (const symbol of assigned) {
      const index = unassignedSymbols.indexOf(symbol);
      if (index >= 0) {
        unassignedSymbols.splice(index, 1);
      }
    }
    return populateRegion(region, assigned);
  });

  return [...unassignedSymbols, ...populatedRegions].sort(compareSourcePosition);
}

function populateRegion(region: OutlineSymbol, symbols: readonly OutlineSymbol[]): OutlineSymbol {
  const remaining = [...symbols];
  const branches = region.children.map((branch) => {
    const assigned = remaining.filter((symbol) => containsRange(branch.range, symbol.range));
    for (const symbol of assigned) {
      const index = remaining.indexOf(symbol);
      if (index >= 0) {
        remaining.splice(index, 1);
      }
    }
    const nestedRegions = branch.children.filter((child) => child.kind === 'PreprocessorRegion');
    return {
      ...branch,
      children: mergeOutlineLevels(assigned, nestedRegions),
    };
  });
  return {
    ...region,
    children: [...remaining, ...branches].sort(compareSourcePosition),
  };
}

function simplifyPreprocessorRegions(symbols: readonly OutlineSymbol[]): OutlineSymbol[] {
  return symbols.map((symbol) => {
    const children = simplifyPreprocessorRegions(symbol.children);
    if (symbol.kind !== 'PreprocessorRegion') return { ...symbol, children };

    const firstBranch = children.find((child) => (
      child.kind === 'PreprocessorBranch'
      && child.range.start.line === symbol.range.start.line
    ));
    if (firstBranch === undefined) return { ...symbol, children };

    return {
      ...symbol,
      children: children.flatMap((child) => child === firstBranch ? child.children : [child]),
    };
  });
}

function isProvenStructDuplicate(left: OutlineSymbol, right: OutlineSymbol): boolean {
  if (left.parentPath !== right.parentPath) {
    return false;
  }
  const leftStruct = left.kind === 'Struct';
  const rightStruct = right.kind === 'Struct';
  if (!leftStruct && !rightStruct) {
    return false;
  }
  if (!leftStruct && !STRUCT_ALIAS_KINDS.has(left.kind)) {
    return false;
  }
  if (!rightStruct && !STRUCT_ALIAS_KINDS.has(right.kind)) {
    return false;
  }
  if (normalizeStructName(left.name) !== normalizeStructName(right.name)) {
    return false;
  }
  if (rangesOverlap(left.range, right.range)) {
    return true;
  }
  const struct = leftStruct ? left : right;
  const alias = leftStruct ? right : left;
  return Math.abs(alias.selectionRange.start.line - struct.range.end.line) <= 1
    && alias.range.start.line >= struct.range.start.line;
}

function mergeStructPair(left: OutlineSymbol, right: OutlineSymbol): OutlineSymbol {
  const preferred = structQuality(right) > structQuality(left) ? right : left;
  const secondary = preferred === left ? right : left;
  const childMap = new Map<string, OutlineSymbol>();
  for (const child of [...preferred.children, ...secondary.children]) {
    childMap.set(`${child.editKey}|${child.range.start.line}:${child.range.start.character}`, child);
  }
  return {
    ...preferred,
    detail: preferred.detail.length > 0 ? preferred.detail : secondary.detail,
    children: mergeDuplicateStructSymbols([...childMap.values()]).sort(compareSourcePosition),
  };
}

function structQuality(symbol: OutlineSymbol): number {
  return (symbol.kind === 'Struct' ? 10_000 : 0)
    + symbol.children.length * 1_000
    + symbol.span;
}

function normalizeStructName(name: string): string {
  return name
    .replace(/^\s*(typedef\s+)?struct\s+/i, '')
    .replace(/[{};]+$/g, '')
    .trim()
    .toLocaleLowerCase('en-US');
}

function normalizeDirectiveSummary(value: string): string {
  return value.replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/g, '').replace(/\s+/g, ' ').trim();
}

function stripCommentsForDirective(
  value: string,
  startsInBlockComment: boolean,
): { readonly text: string; readonly inBlockComment: boolean } {
  let inBlockComment = startsInBlockComment;
  let result = '';
  let quote = '';

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index] ?? '';
    const next = value[index + 1] ?? '';
    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        result += '  ';
        index += 1;
      } else {
        result += ' ';
      }
      continue;
    }
    if (quote.length > 0) {
      result += current;
      if (current === '\\') {
        result += next;
        index += 1;
      } else if (current === quote) {
        quote = '';
      }
      continue;
    }
    if (current === '\"' || current === "'") {
      quote = current;
      result += current;
      continue;
    }
    if (current === '/' && next === '*') {
      inBlockComment = true;
      result += '  ';
      index += 1;
      continue;
    }
    if (current === '/' && next === '/') {
      break;
    }
    result += current;
  }

  return { text: result, inBlockComment };
}

function formatDirective(directive: string, summary: string): string {
  return summary.length === 0 ? `#${directive}` : `#${directive} ${summary}`;
}

function lineRange(startLine: number, endLine: number, lines: readonly string[]): OutlineRange {
  return {
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: (lines[endLine] ?? '').length },
  };
}

function containsRange(outer: OutlineRange, inner: OutlineRange): boolean {
  return comparePosition(outer.start, inner.start) <= 0 && comparePosition(inner.end, outer.end) <= 0;
}

function rangesOverlap(left: OutlineRange, right: OutlineRange): boolean {
  return comparePosition(left.start, right.end) <= 0 && comparePosition(right.start, left.end) <= 0;
}

function compareSourcePosition(left: OutlineSymbol, right: OutlineSymbol): number {
  return comparePosition(left.selectionRange.start, right.selectionRange.start);
}

function comparePosition(
  left: { readonly line: number; readonly character: number },
  right: { readonly line: number; readonly character: number },
): number {
  return left.line - right.line || left.character - right.character;
}
