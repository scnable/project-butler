import { randomUUID } from 'node:crypto';
import {
  CatalogProjectType,
  CatalogSymbolOutlineSettings,
  CatalogTabSettings,
} from './catalogModel';
import { CatalogTodoOverrides } from '../todo/todoSettings';
import { normalizeTodoTagName } from '../todo/todoTags';

export const INTERNAL_CATALOG_STORAGE_VERSION = 3;
const SUPPORTED_INTERNAL_CATALOG_STORAGE_VERSIONS = new Set([1, 2, INTERNAL_CATALOG_STORAGE_VERSION]);

export interface StoredCatalogFeatureOverrides {
  readonly tabs: Partial<CatalogTabSettings>;
  readonly symbolOutline: Partial<CatalogSymbolOutlineSettings>;
  readonly todo: CatalogTodoOverrides;
}

export interface StoredCatalogProject {
  readonly id: string;
  readonly alias: string;
  readonly uri: string;
  readonly type: Exclude<CatalogProjectType, 'auto'>;
  readonly description?: string;
  readonly tags: readonly string[];
}

export interface StoredProjectCatalog {
  readonly id: string;
  readonly name: string;
  readonly features: StoredCatalogFeatureOverrides;
  readonly projects: readonly StoredCatalogProject[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CatalogLibrary {
  readonly storageVersion: number;
  readonly catalogs: readonly StoredProjectCatalog[];
}

export interface CatalogLibraryLoadResult {
  readonly library: CatalogLibrary;
  readonly issues: readonly string[];
}

export interface NewStoredProject {
  readonly alias: string;
  readonly uri: string;
  readonly type: Exclude<CatalogProjectType, 'auto'>;
  readonly description?: string;
  readonly tags?: readonly string[];
}

export function createEmptyCatalogLibrary(): CatalogLibrary {
  return { storageVersion: INTERNAL_CATALOG_STORAGE_VERSION, catalogs: [] };
}

export function chooseStoredCatalogToRestore(
  availableIds: readonly string[],
  restoreSuppressed: boolean,
  candidates: readonly (string | undefined)[],
): string | undefined {
  if (restoreSuppressed) {
    return undefined;
  }
  const available = new Set(availableIds);
  return candidates.find((candidate): candidate is string => candidate !== undefined && available.has(candidate));
}

export function createStoredCatalog(name: string, projects: readonly NewStoredProject[] = []): StoredProjectCatalog {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: normalizeCatalogName(name),
    features: {
      tabs: {},
      symbolOutline: {},
      todo: {},
    },
    projects: projects.map(createStoredProject),
    createdAt: now,
    updatedAt: now,
  };
}

export function createStoredProject(project: NewStoredProject): StoredCatalogProject {
  return {
    id: randomUUID(),
    alias: project.alias.trim(),
    uri: project.uri,
    type: project.type,
    ...(project.description === undefined || project.description.trim().length === 0
      ? {}
      : { description: project.description.trim() }),
    tags: [...new Set((project.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))],
  };
}

export function loadCatalogLibrary(raw: unknown): CatalogLibraryLoadResult {
  const issues: string[] = [];
  if (!isRecord(raw)) {
    return { library: createEmptyCatalogLibrary(), issues: raw === undefined ? [] : ['内部集合存储不是对象，已使用空集合库。'] };
  }
  if (!SUPPORTED_INTERNAL_CATALOG_STORAGE_VERSIONS.has(Number(raw.storageVersion)) || !Array.isArray(raw.catalogs)) {
    return {
      library: createEmptyCatalogLibrary(),
      issues: ['内部集合存储版本或结构不受支持，已使用空集合库。'],
    };
  }

  const usedCatalogIds = new Set<string>();
  const catalogs: StoredProjectCatalog[] = [];
  for (const [catalogIndex, rawCatalog] of raw.catalogs.entries()) {
    if (!isRecord(rawCatalog)) {
      issues.push(`集合 #${catalogIndex + 1} 不是对象，已忽略。`);
      continue;
    }
    const id = readNonEmptyString(rawCatalog.id);
    const name = readNonEmptyString(rawCatalog.name);
    if (id === undefined || name === undefined || usedCatalogIds.has(id)) {
      issues.push(`集合 #${catalogIndex + 1} 缺少有效且唯一的 id/name，已忽略。`);
      continue;
    }
    usedCatalogIds.add(id);
    const projects = loadProjects(rawCatalog.projects, name, issues);
    catalogs.push({
      id,
      name,
      features: loadFeatures(rawCatalog.features, name, issues),
      projects,
      createdAt: readNonEmptyString(rawCatalog.createdAt) ?? new Date(0).toISOString(),
      updatedAt: readNonEmptyString(rawCatalog.updatedAt) ?? new Date(0).toISOString(),
    });
  }
  return { library: { storageVersion: INTERNAL_CATALOG_STORAGE_VERSION, catalogs }, issues };
}

export function replaceCatalog(library: CatalogLibrary, nextCatalog: StoredProjectCatalog): CatalogLibrary {
  return {
    ...library,
    catalogs: library.catalogs.map((catalog) => catalog.id === nextCatalog.id ? nextCatalog : catalog),
  };
}

export function appendCatalog(library: CatalogLibrary, catalog: StoredProjectCatalog): CatalogLibrary {
  return { ...library, catalogs: [...library.catalogs, catalog] };
}

export function withUpdatedCatalog(
  catalog: StoredProjectCatalog,
  update: Partial<Pick<StoredProjectCatalog, 'name' | 'features' | 'projects'>>,
): StoredProjectCatalog {
  return { ...catalog, ...update, updatedAt: new Date().toISOString() };
}

export function withRenamedCatalog(catalog: StoredProjectCatalog, name: string): StoredProjectCatalog {
  return withUpdatedCatalog(catalog, { name: normalizeCatalogName(name) });
}

export function withRenamedProject(
  catalog: StoredProjectCatalog,
  projectId: string,
  alias: string,
): StoredProjectCatalog {
  return withReplacedProject(catalog, projectId, (project) => ({ ...project, alias: alias.trim() }));
}

export function withUpdatedProjectResource(
  catalog: StoredProjectCatalog,
  projectId: string,
  uri: string,
  type: StoredCatalogProject['type'],
): StoredProjectCatalog {
  return withReplacedProject(catalog, projectId, (project) => ({ ...project, uri, type }));
}

export function withoutStoredProject(catalog: StoredProjectCatalog, projectId: string): StoredProjectCatalog {
  if (!catalog.projects.some((project) => project.id === projectId)) {
    return catalog;
  }
  return withUpdatedCatalog(catalog, {
    projects: catalog.projects.filter((project) => project.id !== projectId),
  });
}

function withReplacedProject(
  catalog: StoredProjectCatalog,
  projectId: string,
  update: (project: StoredCatalogProject) => StoredCatalogProject,
): StoredProjectCatalog {
  if (!catalog.projects.some((project) => project.id === projectId)) {
    return catalog;
  }
  return withUpdatedCatalog(catalog, {
    projects: catalog.projects.map((project) => project.id === projectId ? update(project) : project),
  });
}

function loadProjects(raw: unknown, catalogName: string, issues: string[]): StoredCatalogProject[] {
  if (!Array.isArray(raw)) {
    issues.push(`集合“${catalogName}”的 projects 无效，已使用空项目列表。`);
    return [];
  }
  const aliases = new Set<string>();
  const ids = new Set<string>();
  const result: StoredCatalogProject[] = [];
  for (const [index, value] of raw.entries()) {
    if (!isRecord(value)) {
      issues.push(`集合“${catalogName}”的项目 #${index + 1} 无效，已忽略。`);
      continue;
    }
    const id = readNonEmptyString(value.id);
    const alias = readNonEmptyString(value.alias);
    const uri = readNonEmptyString(value.uri);
    const type = value.type === 'workspace' ? 'workspace' : value.type === 'folder' ? 'folder' : undefined;
    const aliasKey = alias?.toLocaleLowerCase();
    if (id === undefined || alias === undefined || uri === undefined || type === undefined
      || ids.has(id) || aliasKey === undefined || aliases.has(aliasKey)) {
      issues.push(`集合“${catalogName}”的项目 #${index + 1} 缺少有效且唯一的 id/alias/uri/type，已忽略。`);
      continue;
    }
    ids.add(id);
    aliases.add(aliasKey);
    const description = readNonEmptyString(value.description);
    result.push({
      id,
      alias,
      uri,
      type,
      ...(description === undefined ? {} : { description }),
      tags: Array.isArray(value.tags)
        ? [...new Set(value.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean))]
        : [],
    });
  }
  return result;
}

function loadFeatures(raw: unknown, catalogName: string, issues: string[]): StoredCatalogFeatureOverrides {
  const inheritedFeatures: StoredCatalogFeatureOverrides = { tabs: {}, symbolOutline: {}, todo: {} };
  if (!isRecord(raw)) {
    if (raw !== undefined) {
      issues.push(`集合“${catalogName}”的功能配置无效，已改为跟随个人默认。`);
    }
    return inheritedFeatures;
  }
  let tabs: StoredCatalogFeatureOverrides['tabs'] = {};
  if (isRecord(raw.tabs) && typeof raw.tabs.autoOrganize === 'boolean') {
    tabs = { autoOrganize: raw.tabs.autoOrganize };
  } else if (raw.tabs !== undefined && (!isRecord(raw.tabs) || raw.tabs.autoOrganize !== undefined)) {
    issues.push(`集合“${catalogName}”的标签配置无效，已改为跟随个人默认。`);
  }
  const mode = isRecord(raw.symbolOutline)
    && (raw.symbolOutline.mode === 'native' || raw.symbolOutline.mode === 'enhanced' || raw.symbolOutline.mode === 'both')
    ? raw.symbolOutline.mode
    : undefined;
  if (raw.symbolOutline !== undefined && mode === undefined
    && (!isRecord(raw.symbolOutline) || raw.symbolOutline.mode !== undefined)) {
    issues.push(`集合“${catalogName}”的函数大纲配置无效，已改为跟随个人默认。`);
  }
  const todo = loadTodoFeatures(raw.todo, catalogName, issues);
  return {
    tabs,
    symbolOutline: mode === undefined ? {} : { mode },
    todo,
  };
}

function loadTodoFeatures(raw: unknown, catalogName: string, issues: string[]): CatalogTodoOverrides {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    issues.push(`集合“${catalogName}”的代码 TODO 配置无效，已改为跟随个人默认。`);
    return {};
  }
  const result: { enabled?: boolean; tags?: readonly string[]; markdownTasks?: boolean } = {};
  if (raw.enabled === undefined || typeof raw.enabled === 'boolean') {
    if (typeof raw.enabled === 'boolean') result.enabled = raw.enabled;
  } else {
    issues.push(`集合“${catalogName}”的代码 TODO enabled 无效，已改为跟随个人默认。`);
  }
  const tags = readTodoTags(raw.tags);
  if (raw.tags === undefined || tags !== undefined) {
    if (tags !== undefined) result.tags = tags;
  } else {
    issues.push(`集合“${catalogName}”的代码 TODO tags 无效，已改为跟随个人默认。`);
  }
  if (raw.markdownTasks === undefined || typeof raw.markdownTasks === 'boolean') {
    if (typeof raw.markdownTasks === 'boolean') result.markdownTasks = raw.markdownTasks;
  } else {
    issues.push(`集合“${catalogName}”的代码 TODO markdownTasks 无效，已改为跟随个人默认。`);
  }
  return result;
}

function readTodoTags(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const normalized = value.map(normalizeTodoTagName);
  if (normalized.some((item) => item === undefined)) return undefined;
  return [...new Set(normalized as string[])];
}

function normalizeCatalogName(name: string): string {
  const normalized = name.trim();
  return normalized.length === 0 ? '未命名集合' : normalized.slice(0, 80);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
