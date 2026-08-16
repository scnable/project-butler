import { CatalogSymbolOutlineSettings, CatalogTabSettings, stripJsonComments } from './catalogModel';

export interface NewCatalogProject {
  readonly alias: string;
  readonly path: string;
  readonly type: 'folder' | 'workspace';
  readonly description?: string;
  readonly tags?: readonly string[];
}

export interface CatalogProjectInsertion {
  readonly entryOffset: number;
  readonly entryText: string;
  readonly commaOffset?: number;
}

export interface CatalogTextReplacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function createCatalogTabSettingsEdits(
  source: string,
  settings: CatalogTabSettings,
): CatalogTextReplacement[] {
  return createCatalogFeatureSettingsEdits(source, 'tabs', 'autoOrganize', settings, settings.autoOrganize);
}

export function createCatalogSymbolOutlineSettingsEdits(
  source: string,
  settings: CatalogSymbolOutlineSettings,
): CatalogTextReplacement[] {
  return createCatalogFeatureSettingsEdits(source, 'symbolOutline', 'mode', settings, settings.mode);
}

function createCatalogFeatureSettingsEdits(
  source: string,
  featureName: 'tabs' | 'symbolOutline',
  settingName: 'autoOrganize' | 'mode',
  settings: CatalogTabSettings | CatalogSymbolOutlineSettings,
  settingValue: boolean | string,
): CatalogTextReplacement[] {
  const cleanSource = stripJsonComments(source);
  const root = findRootObject(cleanSource);
  const schemaVersion = findObjectProperty(cleanSource, root, 'schemaVersion');
  const projects = findObjectProperty(cleanSource, root, 'projects');
  if (schemaVersion === undefined || projects === undefined) {
    throw new Error('集合文件必须包含 schemaVersion 和 projects。');
  }

  const edits: CatalogTextReplacement[] = [{
    start: schemaVersion.valueStart,
    end: schemaVersion.valueEnd,
    text: '3',
  }];
  const sourceVersion = Number(cleanSource.slice(schemaVersion.valueStart, schemaVersion.valueEnd));
  const features = findObjectProperty(cleanSource, root, 'features');
  if (features === undefined) {
    const indent = getLineIndent(source, projects.propertyStart);
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const projectsLineStart = Math.max(source.lastIndexOf('\n', projects.propertyStart - 1) + 1, 0);
    const projectsHasOwnLine = source.slice(projectsLineStart, projects.propertyStart).trim().length === 0;
    const insertionOffset = projectsHasOwnLine ? projectsLineStart : projects.propertyStart;
    edits.push({
      start: insertionOffset,
      end: insertionOffset,
      text: projectsHasOwnLine
        ? `${indent}"features": ${serializeIndented({ [featureName]: settings }, indent, newline)},${newline}${newline}`
        : `"features": ${serializeIndented({ [featureName]: settings }, indent, newline)},${newline}${indent}`,
    });
    return edits;
  }

  if (cleanSource[features.valueStart] !== '{') {
    const indent = getLineIndent(source, features.propertyStart);
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    edits.push({
      start: features.valueStart,
      end: features.valueEnd,
      text: serializeIndented({ [featureName]: settings }, indent, newline),
    });
    return edits;
  }

  const featuresObject = {
    open: features.valueStart,
    close: findMatchingBracket(cleanSource, features.valueStart, '{', '}'),
  };
  if (sourceVersion === 2 && featureName === 'symbolOutline') {
    const legacyTabs = findObjectProperty(cleanSource, featuresObject, 'tabs');
    if (legacyTabs !== undefined && cleanSource[legacyTabs.valueStart] === '{') {
      const legacyTabsObject = {
        open: legacyTabs.valueStart,
        close: findMatchingBracket(cleanSource, legacyTabs.valueStart, '{', '}'),
      };
      const groupingMode = findObjectProperty(cleanSource, legacyTabsObject, 'groupingMode');
      const autoOrganize = groupingMode !== undefined
        && cleanSource.slice(groupingMode.valueStart, groupingMode.valueEnd) === '"auto"';
      const indent = getLineIndent(source, legacyTabs.propertyStart);
      const newline = source.includes('\r\n') ? '\r\n' : '\n';
      edits.push({
        start: legacyTabs.valueStart,
        end: legacyTabs.valueEnd,
        text: serializeIndented({ autoOrganize }, indent, newline),
      });
    }
  }
  const tabs = findObjectProperty(cleanSource, featuresObject, featureName);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  if (tabs !== undefined) {
    if (sourceVersion === 3 && cleanSource[tabs.valueStart] === '{') {
      const tabsObject = {
        open: tabs.valueStart,
        close: findMatchingBracket(cleanSource, tabs.valueStart, '{', '}'),
      };
      const property = findObjectProperty(cleanSource, tabsObject, settingName);
      if (property === undefined) {
        edits.push(...createObjectPropertyInsertion(
          source,
          cleanSource,
          tabsObject,
          settingName,
          settingValue,
          newline,
        ));
      } else {
        edits.push({
          start: property.valueStart,
          end: property.valueEnd,
          text: JSON.stringify(settingValue),
        });
      }
      return edits;
    }
    const indent = getLineIndent(source, tabs.propertyStart);
    edits.push({
      start: tabs.valueStart,
      end: tabs.valueEnd,
      text: serializeIndented(settings, indent, newline),
    });
    return edits;
  }

  edits.push(...createObjectPropertyInsertion(source, cleanSource, featuresObject, featureName, settings, newline));
  return edits;
}

export function createCatalogProjectInsertion(
  source: string,
  project: NewCatalogProject,
): CatalogProjectInsertion {
  const cleanSource = stripJsonComments(source);
  const bounds = findTopLevelProjectsArray(cleanSource);
  if (bounds === undefined) {
    throw new Error('找不到顶层 projects 数组。');
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const closingLineStart = Math.max(
    source.lastIndexOf('\n', bounds.closeBracket - 1) + 1,
    0,
  );
  const beforeClosingBracket = source.slice(closingLineStart, bounds.closeBracket);
  const closingBracketHasOwnLine = beforeClosingBracket.trim().length === 0;
  const closingIndent = closingBracketHasOwnLine ? beforeClosingBracket : getLineIndent(source, bounds.openBracket);
  const entryIndent = `${closingIndent}  `;
  const serializedProject = JSON.stringify(project, undefined, 2)
    .split('\n')
    .map((line) => `${entryIndent}${line}`)
    .join(newline);

  const arrayContent = cleanSource.slice(bounds.openBracket + 1, bounds.closeBracket);
  const lastContentIndex = findLastNonWhitespaceIndex(arrayContent);
  const hasExistingProject = lastContentIndex >= 0;
  const lastContentOffset = hasExistingProject
    ? bounds.openBracket + 1 + lastContentIndex
    : undefined;
  const alreadyHasTrailingComma = lastContentOffset !== undefined && cleanSource[lastContentOffset] === ',';

  if (closingBracketHasOwnLine) {
    return {
      entryOffset: closingLineStart,
      entryText: `${serializedProject}${newline}`,
      ...(!hasExistingProject || alreadyHasTrailingComma || lastContentOffset === undefined
        ? {}
        : { commaOffset: lastContentOffset + 1 }),
    };
  }

  return {
    entryOffset: bounds.closeBracket,
    entryText: `${newline}${serializedProject}${newline}${closingIndent}`,
    ...(!hasExistingProject || alreadyHasTrailingComma || lastContentOffset === undefined
      ? {}
      : { commaOffset: lastContentOffset + 1 }),
  };
}

interface ArrayBounds {
  readonly openBracket: number;
  readonly closeBracket: number;
}

interface ObjectBounds {
  readonly open: number;
  readonly close: number;
}

interface ObjectPropertyBounds {
  readonly propertyStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

function findRootObject(source: string): ObjectBounds {
  const open = skipWhitespace(source, 0);
  if (source[open] !== '{') {
    throw new Error('项目集合根节点必须是对象。');
  }
  return { open, close: findMatchingBracket(source, open, '{', '}') };
}

function findObjectProperty(
  source: string,
  object: ObjectBounds,
  expectedName: string,
): ObjectPropertyBounds | undefined {
  let cursor = object.open + 1;
  while (cursor < object.close) {
    cursor = skipWhitespaceAndCommas(source, cursor);
    if (cursor >= object.close) {
      break;
    }
    if (source[cursor] !== '"') {
      throw new Error('对象属性名必须是字符串。');
    }
    const propertyStart = cursor;
    const stringEnd = findStringEnd(source, cursor);
    const propertyName = JSON.parse(source.slice(cursor, stringEnd + 1)) as unknown;
    cursor = skipWhitespace(source, stringEnd + 1);
    if (source[cursor] !== ':') {
      throw new Error('对象属性缺少冒号。');
    }
    const valueStart = skipWhitespace(source, cursor + 1);
    const valueEnd = findValueEnd(source, valueStart, object.close);
    if (propertyName === expectedName) {
      return { propertyStart, valueStart, valueEnd };
    }
    cursor = valueEnd;
  }
  return undefined;
}

function findValueEnd(source: string, start: number, objectClose: number): number {
  const first = source[start];
  if (first === '"') {
    return findStringEnd(source, start) + 1;
  }
  if (first === '{') {
    return findMatchingBracket(source, start, '{', '}') + 1;
  }
  if (first === '[') {
    return findMatchingBracket(source, start, '[', ']') + 1;
  }
  let cursor = start;
  while (cursor < objectClose && source[cursor] !== ',') {
    cursor += 1;
  }
  while (cursor > start && /\s/u.test(source[cursor - 1] ?? '')) {
    cursor -= 1;
  }
  return cursor;
}

function findMatchingBracket(
  source: string,
  openOffset: number,
  openCharacter: '{' | '[',
  closeCharacter: '}' | ']',
): number {
  let depth = 0;
  for (let index = openOffset; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      index = findStringEnd(source, index);
      continue;
    }
    if (character === openCharacter) {
      depth += 1;
    } else if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error(`配置缺少结束符号 ${closeCharacter}。`);
}

function createObjectPropertyInsertion(
  source: string,
  cleanSource: string,
  object: ObjectBounds,
  propertyName: string,
  value: unknown,
  newline: string,
): CatalogTextReplacement[] {
  return createObjectPropertiesInsertion(source, cleanSource, object, [[propertyName, value]], newline);
}

function createObjectPropertiesInsertion(
  source: string,
  cleanSource: string,
  object: ObjectBounds,
  properties: ReadonlyArray<readonly [string, unknown]>,
  newline: string,
): CatalogTextReplacement[] {
  const content = cleanSource.slice(object.open + 1, object.close);
  const lastContentIndex = findLastNonWhitespaceIndex(content);
  const lastContentOffset = lastContentIndex < 0 ? undefined : object.open + 1 + lastContentIndex;
  const hasTrailingComma = lastContentOffset !== undefined && cleanSource[lastContentOffset] === ',';
  const closingLineStart = Math.max(source.lastIndexOf('\n', object.close - 1) + 1, 0);
  const closingPrefix = source.slice(closingLineStart, object.close);
  const closingHasOwnLine = closingPrefix.trim().length === 0;
  const closingIndent = closingHasOwnLine ? closingPrefix : getLineIndent(source, object.open);
  const propertyIndent = `${closingIndent}  `;
  const propertyText = properties
    .map(([propertyName, value]) => `${propertyIndent}"${propertyName}": ${serializeIndented(value, propertyIndent, newline)}`)
    .join(`,${newline}`);
  const edits: CatalogTextReplacement[] = [];
  if (lastContentOffset !== undefined && !hasTrailingComma) {
    edits.push({ start: lastContentOffset + 1, end: lastContentOffset + 1, text: ',' });
  }
  if (closingHasOwnLine) {
    edits.push({ start: closingLineStart, end: closingLineStart, text: `${propertyText}${newline}` });
  } else {
    edits.push({
      start: object.close,
      end: object.close,
      text: `${newline}${propertyText}${newline}${closingIndent}`,
    });
  }
  return edits;
}

function serializeIndented(value: unknown, indent: string, newline: string): string {
  return JSON.stringify(value, undefined, 2)
    .split('\n')
    .map((line, index) => index === 0 ? line : `${indent}${line}`)
    .join(newline);
}

function findTopLevelProjectsArray(source: string): ArrayBounds | undefined {
  let objectDepth = 0;
  let arrayDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (character === '"') {
      const stringEnd = findStringEnd(source, index);
      if (objectDepth === 1 && arrayDepth === 0) {
        const propertyName = JSON.parse(source.slice(index, stringEnd + 1)) as unknown;
        let cursor = skipWhitespace(source, stringEnd + 1);
        if (propertyName === 'projects' && source[cursor] === ':') {
          cursor = skipWhitespace(source, cursor + 1);
          if (source[cursor] === '[') {
            return {
              openBracket: cursor,
              closeBracket: findMatchingArrayBracket(source, cursor),
            };
          }
        }
      }
      index = stringEnd;
      continue;
    }

    if (character === '{') {
      objectDepth += 1;
    } else if (character === '}') {
      objectDepth -= 1;
    } else if (character === '[') {
      arrayDepth += 1;
    } else if (character === ']') {
      arrayDepth -= 1;
    }
  }

  return undefined;
}

function findMatchingArrayBracket(source: string, openBracket: number): number {
  let depth = 0;
  for (let index = openBracket; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (character === '"') {
      index = findStringEnd(source, index);
      continue;
    }
    if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error('projects 数组缺少结束符号 ]。');
}

function findStringEnd(source: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      return index;
    }
  }
  throw new Error('JSONC 字符串缺少结束引号。');
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/u.test(source[index] ?? '')) {
    index += 1;
  }
  return index;
}

function skipWhitespaceAndCommas(source: string, start: number): number {
  let index = start;
  while (index < source.length && (/\s/u.test(source[index] ?? '') || source[index] === ',')) {
    index += 1;
  }
  return index;
}

function findLastNonWhitespaceIndex(value: string): number {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (!/\s/u.test(value[index] ?? '')) {
      return index;
    }
  }
  return -1;
}

function getLineIndent(source: string, offset: number): string {
  const lineStart = Math.max(source.lastIndexOf('\n', offset - 1) + 1, 0);
  const linePrefix = source.slice(lineStart, offset);
  return /^\s*/u.exec(linePrefix)?.[0] ?? '';
}
