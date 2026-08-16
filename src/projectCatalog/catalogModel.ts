export const CATALOG_FILE_SUFFIX = '.project-butler.json';
export const SUPPORTED_CATALOG_SCHEMA_VERSION = 3;
export const MINIMUM_CATALOG_SCHEMA_VERSION = 1;

export type CatalogProjectType = 'auto' | 'folder' | 'workspace';
export type CatalogCompatibility = 'current' | 'legacy' | 'unsupported' | 'invalid';

export interface CatalogTabSettings {
  readonly autoOrganize: boolean;
}

export type CatalogSymbolOutlineMode = 'native' | 'enhanced' | 'both';

export interface CatalogSymbolOutlineSettings {
  readonly mode: CatalogSymbolOutlineMode;
}

export interface CatalogFeatures {
  readonly tabs: CatalogTabSettings;
  readonly symbolOutline: CatalogSymbolOutlineSettings;
}

export const DEFAULT_CATALOG_TAB_SETTINGS: CatalogTabSettings = {
  autoOrganize: false,
};

export const DEFAULT_CATALOG_SYMBOL_OUTLINE_SETTINGS: CatalogSymbolOutlineSettings = {
  mode: 'both',
};

const DEFAULT_CATALOG_FEATURES: CatalogFeatures = {
  tabs: DEFAULT_CATALOG_TAB_SETTINGS,
  symbolOutline: DEFAULT_CATALOG_SYMBOL_OUTLINE_SETTINGS,
};

export interface CatalogIssue {
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly projectIndex?: number;
}

export interface CatalogProject {
  readonly index: number;
  readonly alias: string;
  readonly path: string;
  readonly type: CatalogProjectType;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly issues: readonly CatalogIssue[];
}

export interface ProjectCatalog {
  readonly schemaVersion: number | undefined;
  readonly compatibility: CatalogCompatibility;
  readonly name: string | undefined;
  readonly features: CatalogFeatures;
  readonly projects: readonly CatalogProject[];
  readonly issues: readonly CatalogIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCatalogFileName(path: string): boolean {
  return path.toLocaleLowerCase().endsWith(CATALOG_FILE_SUFFIX);
}

export function isPortableRelativePath(path: string): boolean {
  if (path.length === 0 || path.includes('\\')) {
    return false;
  }

  return !(path.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path));
}

export function inferProjectType(path: string, declaredType: CatalogProjectType): Exclude<CatalogProjectType, 'auto'> {
  if (declaredType !== 'auto') {
    return declaredType;
  }

  return path.toLocaleLowerCase().endsWith('.code-workspace') ? 'workspace' : 'folder';
}

export function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    const nextCharacter = text[index + 1] ?? '';

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      result += '  ';
      index += 2;
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') {
        result += ' ';
        index += 1;
      }
      index -= 1;
      continue;
    }

    if (character === '/' && nextCharacter === '*') {
      result += '  ';
      index += 2;
      let closed = false;
      while (index < text.length) {
        const blockCharacter = text[index] ?? '';
        const blockNextCharacter = text[index + 1] ?? '';
        if (blockCharacter === '*' && blockNextCharacter === '/') {
          result += '  ';
          index += 1;
          closed = true;
          break;
        }
        result += blockCharacter === '\n' || blockCharacter === '\r' ? blockCharacter : ' ';
        index += 1;
      }
      if (!closed) {
        throw new SyntaxError('块注释缺少结束标记 */。');
      }
      continue;
    }

    result += character;
  }

  return result;
}

export function stripTrailingCommas(text: string): string {
  const characters = [...text];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? '';
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== ',') {
      continue;
    }

    let cursor = index + 1;
    while (cursor < characters.length && /\s/u.test(characters[cursor] ?? '')) {
      cursor += 1;
    }
    if (characters[cursor] === '}' || characters[cursor] === ']') {
      characters[index] = ' ';
    }
  }
  return characters.join('');
}

export function parseProjectCatalogText(text: string): ProjectCatalog {
  let value: unknown;
  try {
    value = JSON.parse(stripTrailingCommas(stripJsonComments(text))) as unknown;
  } catch (error) {
    return {
      schemaVersion: undefined,
      compatibility: 'invalid',
      name: undefined,
      features: DEFAULT_CATALOG_FEATURES,
      projects: [],
      issues: [{
        message: `JSON/JSONC 语法错误：${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
      }],
    };
  }

  if (!isRecord(value)) {
    return {
      schemaVersion: undefined,
      compatibility: 'invalid',
      name: undefined,
      features: DEFAULT_CATALOG_FEATURES,
      projects: [],
      issues: [{ message: '项目集合根节点必须是 JSON 对象。', severity: 'error' }],
    };
  }

  const issues: CatalogIssue[] = [];
  const schemaVersion = typeof value.schemaVersion === 'number' && Number.isInteger(value.schemaVersion)
    ? value.schemaVersion
    : undefined;
  let compatibility: CatalogCompatibility = 'current';
  if (schemaVersion === undefined) {
    issues.push({ message: '缺少整数类型的 schemaVersion。', severity: 'error' });
    compatibility = 'invalid';
  } else if (schemaVersion < MINIMUM_CATALOG_SCHEMA_VERSION || schemaVersion > SUPPORTED_CATALOG_SCHEMA_VERSION) {
    issues.push({
      message: `不支持 schemaVersion ${schemaVersion}，当前仅支持 ${SUPPORTED_CATALOG_SCHEMA_VERSION}。`,
      severity: 'error',
    });
    compatibility = 'unsupported';
  } else if (schemaVersion < SUPPORTED_CATALOG_SCHEMA_VERSION) {
    compatibility = 'legacy';
  }

  const features = parseCatalogFeatures(value.features, schemaVersion, issues);

  const name = typeof value.name === 'string' && value.name.trim().length > 0
    ? value.name.trim()
    : undefined;
  if (value.name !== undefined && name === undefined) {
    issues.push({ message: 'name 必须是非空字符串。', severity: 'warning' });
  }

  if (!Array.isArray(value.projects)) {
    issues.push({ message: 'projects 必须是数组。', severity: 'error' });
    return { schemaVersion, compatibility, name, features, projects: [], issues };
  }

  const aliases = new Set<string>();
  const projects = value.projects.map((item: unknown, index: number): CatalogProject => {
    const projectIssues: CatalogIssue[] = [];
    if (!isRecord(item)) {
      projectIssues.push({ message: `项目 #${index + 1} 必须是对象。`, severity: 'error', projectIndex: index });
      return {
        index,
        alias: `无效项目 #${index + 1}`,
        path: '',
        type: 'auto',
        tags: [],
        issues: projectIssues,
      };
    }

    const alias = typeof item.alias === 'string' ? item.alias.trim() : '';
    if (alias.length === 0) {
      projectIssues.push({ message: `项目 #${index + 1} 缺少非空 alias。`, severity: 'error', projectIndex: index });
    } else if (alias.length > 64) {
      projectIssues.push({ message: `项目“${alias}”的 alias 不能超过 64 个字符。`, severity: 'error', projectIndex: index });
    } else {
      const aliasKey = alias.toLocaleLowerCase();
      if (aliases.has(aliasKey)) {
        projectIssues.push({ message: `项目别名“${alias}”重复。`, severity: 'error', projectIndex: index });
      } else {
        aliases.add(aliasKey);
      }
    }

    const projectPath = typeof item.path === 'string' ? item.path.trim() : '';
    if (!isPortableRelativePath(projectPath)) {
      projectIssues.push({
        message: `项目“${alias || `#${index + 1}`}”的 path 必须是使用 / 分隔的非空相对路径。`,
        severity: 'error',
        projectIndex: index,
      });
    }

    const rawType = item.type ?? 'auto';
    const type: CatalogProjectType = rawType === 'folder' || rawType === 'workspace' || rawType === 'auto'
      ? rawType
      : 'auto';
    if (rawType !== type) {
      projectIssues.push({
        message: `项目“${alias || `#${index + 1}`}”的 type 只能是 auto、folder 或 workspace。`,
        severity: 'error',
        projectIndex: index,
      });
    }

    const description = typeof item.description === 'string' && item.description.trim().length > 0
      ? item.description.trim()
      : undefined;
    if (item.description !== undefined && description === undefined) {
      projectIssues.push({
        message: `项目“${alias || `#${index + 1}`}”的 description 必须是非空字符串。`,
        severity: 'warning',
        projectIndex: index,
      });
    }

    const tags: string[] = [];
    if (item.tags !== undefined) {
      if (!Array.isArray(item.tags) || item.tags.some((tag: unknown) => typeof tag !== 'string' || tag.trim().length === 0)) {
        projectIssues.push({
          message: `项目“${alias || `#${index + 1}`}”的 tags 必须是非空字符串数组。`,
          severity: 'warning',
          projectIndex: index,
        });
      } else {
        tags.push(...item.tags.map((tag: string) => tag.trim()));
      }
    }

    return {
      index,
      alias: alias || `无效项目 #${index + 1}`,
      path: projectPath,
      type,
      ...(description === undefined ? {} : { description }),
      tags,
      issues: projectIssues,
    };
  });

  issues.push(...projects.flatMap((project) => project.issues));
  return { schemaVersion, compatibility, name, features, projects, issues };
}

function parseCatalogFeatures(
  rawFeatures: unknown,
  schemaVersion: number | undefined,
  issues: CatalogIssue[],
): CatalogFeatures {
  if (schemaVersion === 1) {
    if (rawFeatures !== undefined) {
      issues.push({
        message: 'schemaVersion 1 不支持 features；请升级为版本 3 后再使用功能配置。',
        severity: 'warning',
      });
    }
    return DEFAULT_CATALOG_FEATURES;
  }
  if (rawFeatures === undefined) {
    return DEFAULT_CATALOG_FEATURES;
  }
  if (!isRecord(rawFeatures)) {
    issues.push({ message: 'features 必须是对象，当前已使用默认功能配置。', severity: 'warning' });
    return DEFAULT_CATALOG_FEATURES;
  }

  const rawTabs = rawFeatures.tabs;
  let tabs = DEFAULT_CATALOG_TAB_SETTINGS;
  if (rawTabs !== undefined && !isRecord(rawTabs)) {
    issues.push({ message: 'features.tabs 必须是对象，当前已使用默认标签配置。', severity: 'warning' });
  } else if (schemaVersion === 2 && isRecord(rawTabs)) {
    const groupingMode = rawTabs.groupingMode;
    if (groupingMode !== undefined
      && groupingMode !== 'off'
      && groupingMode !== 'prompt'
      && groupingMode !== 'auto') {
      issues.push({ message: 'v2 的 features.tabs.groupingMode 只能是 off、prompt 或 auto。', severity: 'warning' });
    }
    tabs = { autoOrganize: groupingMode === 'auto' };
  } else if (schemaVersion === 3 && isRecord(rawTabs)) {
    const autoOrganize = typeof rawTabs.autoOrganize === 'boolean'
      ? rawTabs.autoOrganize
      : DEFAULT_CATALOG_TAB_SETTINGS.autoOrganize;
    if (rawTabs.autoOrganize !== undefined && typeof rawTabs.autoOrganize !== 'boolean') {
      issues.push({ message: 'features.tabs.autoOrganize 必须是布尔值。', severity: 'warning' });
    }
    if (rawTabs.groupingMode !== undefined || rawTabs.minimumTabs !== undefined || rawTabs.showOpenFileCount !== undefined) {
      issues.push({ message: 'v3 已移除 groupingMode、minimumTabs 和 showOpenFileCount，请改用 autoOrganize。', severity: 'warning' });
    }
    tabs = { autoOrganize };
  }

  let symbolOutline = DEFAULT_CATALOG_SYMBOL_OUTLINE_SETTINGS;
  const rawSymbolOutline = rawFeatures.symbolOutline;
  if (schemaVersion === 2 && rawSymbolOutline !== undefined) {
    issues.push({ message: 'schemaVersion 2 不支持 features.symbolOutline；请升级为版本 3。', severity: 'warning' });
  } else if (schemaVersion === 3 && rawSymbolOutline !== undefined) {
    if (!isRecord(rawSymbolOutline)) {
      issues.push({ message: 'features.symbolOutline 必须是对象，当前已使用默认大纲配置。', severity: 'warning' });
    } else {
      const mode = rawSymbolOutline.mode;
      if (mode === 'native' || mode === 'enhanced' || mode === 'both') {
        symbolOutline = { mode };
      } else if (mode !== undefined) {
        issues.push({ message: 'features.symbolOutline.mode 只能是 native、enhanced 或 both。', severity: 'warning' });
      }
    }
  }

  return { tabs, symbolOutline };
}
