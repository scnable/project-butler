import { TodoMatch, TodoParseOptions } from './todoTypes';

export function parseTodoText(text: string, options: TodoParseOptions): TodoMatch[] {
  const activeTags = options.tags.filter((tag) => tag.enabled);
  if (activeTags.length === 0) return [];
  const tagLookup = new Map(activeTags.map((tag) => [tag.name.toLocaleUpperCase(), tag.name]));
  const tagPattern = [...tagLookup.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const markerPattern = new RegExp(`^(${tagPattern})(?:\\s*\\(\\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,31})\\s*\\))?(?:\\s*\\[([ xX])\\])?(?=\\s|:|$)(?:\\s*:)?\\s*(.*)$`, 'i');
  const lines = text.split(/\r?\n/);
  const matches: TodoMatch[] = [];
  let activeBlock: { readonly close: string } | undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if (options.markdownTasks && tagLookup.has('TODO')) {
      const markdown = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(line);
      if (markdown !== null && markdown[1]?.toLocaleLowerCase() !== 'x') {
        const markerStart = line.indexOf('[');
        matches.push({
          tag: 'TODO', rawTag: 'TODO', text: markdown[2]?.trim() ?? '', line: lineIndex,
          startCharacter: markerStart, endCharacter: markerStart + 3, completed: false, source: 'markdownTask',
        });
      }
    }

    const bodies: { readonly body: string; readonly offset: number }[] = [];
    let searchFrom = 0;
    if (activeBlock !== undefined) {
      const closeIndex = line.indexOf(activeBlock.close);
      const end = closeIndex < 0 ? line.length : closeIndex;
      bodies.push(stripBlockLinePrefix(line.slice(0, end), 0));
      if (closeIndex < 0) {
        collectBodies(matches, bodies, lineIndex, markerPattern, tagLookup);
        continue;
      }
      activeBlock = undefined;
      searchFrom = closeIndex + activeBlockLength(options, line, closeIndex);
    }

    const comment = findCommentStart(line, searchFrom, options);
    if (comment !== undefined) {
      if (comment.kind === 'line') {
        bodies.push({ body: line.slice(comment.index + comment.open.length).trimStart(), offset: comment.index + comment.open.length + leadingWhitespace(line.slice(comment.index + comment.open.length)) });
      } else {
        const contentStart = comment.index + comment.open.length;
        const closeIndex = line.indexOf(comment.close, contentStart);
        const contentEnd = closeIndex < 0 ? line.length : closeIndex;
        const rawBody = line.slice(contentStart, contentEnd);
        bodies.push({ body: rawBody.trimStart(), offset: contentStart + leadingWhitespace(rawBody) });
        if (closeIndex < 0) activeBlock = { close: comment.close };
      }
    }
    collectBodies(matches, bodies, lineIndex, markerPattern, tagLookup);
  }
  return matches;
}

function collectBodies(
  target: TodoMatch[],
  bodies: readonly { readonly body: string; readonly offset: number }[],
  line: number,
  markerPattern: RegExp,
  tags: ReadonlyMap<string, string>,
): void {
  for (const candidate of bodies) {
    const normalized = stripDecoration(candidate.body, candidate.offset);
    const result = markerPattern.exec(normalized.body);
    if (result === null || result[1] === undefined) continue;
    const rawTag = result[1];
    const canonical = tags.get(rawTag.toLocaleUpperCase());
    if (canonical === undefined) continue;
    const completed = result[3]?.toLocaleLowerCase() === 'x';
    if (completed) continue;
    target.push({
      tag: canonical,
      rawTag,
      ...(result[2] === undefined ? {} : { owner: result[2].trim() }),
      text: result[4]?.trim() ?? '',
      line,
      startCharacter: normalized.offset,
      endCharacter: normalized.offset + rawTag.length,
      completed,
      source: 'comment',
    });
  }
}

function findCommentStart(line: string, start: number, options: TodoParseOptions):
  | { readonly kind: 'line'; readonly index: number; readonly open: string }
  | { readonly kind: 'block'; readonly index: number; readonly open: string; readonly close: string }
  | undefined {
  const candidates: Array<{ kind: 'line' | 'block'; index: number; open: string; close?: string }> = [];
  for (const token of options.lineCommentTokens) {
    const index = findOutsideQuotes(line, token, start);
    if (index >= 0) candidates.push({ kind: 'line', index, open: token });
  }
  for (const token of options.blockCommentTokens) {
    const index = findOutsideQuotes(line, token.open, start);
    if (index >= 0) candidates.push({ kind: 'block', index, open: token.open, close: token.close });
  }
  candidates.sort((a, b) => a.index - b.index);
  const first = candidates[0];
  if (first === undefined) return undefined;
  return first.kind === 'line'
    ? { kind: 'line', index: first.index, open: first.open }
    : { kind: 'block', index: first.index, open: first.open, close: first.close ?? '' };
}

function findOutsideQuotes(line: string, token: string, start: number): number {
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index <= line.length - token.length; index += 1) {
    const character = line[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (line.startsWith(token, index)) return index;
  }
  return -1;
}

function stripBlockLinePrefix(body: string, offset: number): { readonly body: string; readonly offset: number } {
  const whitespace = leadingWhitespace(body);
  return { body: body.slice(whitespace), offset: offset + whitespace };
}

function stripDecoration(body: string, offset: number): { readonly body: string; readonly offset: number } {
  const match = /^(?:\*\s*)?/.exec(body)?.[0] ?? '';
  return { body: body.slice(match.length), offset: offset + match.length };
}

function activeBlockLength(options: TodoParseOptions, line: string, closeIndex: number): number {
  const close = options.blockCommentTokens.find((token) => line.startsWith(token.close, closeIndex))?.close;
  return close?.length ?? 0;
}

function leadingWhitespace(value: string): number {
  return /^\s*/.exec(value)?.[0].length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
