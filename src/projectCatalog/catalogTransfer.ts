import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  DEFAULT_CATALOG_SYMBOL_OUTLINE_SETTINGS,
  DEFAULT_CATALOG_TAB_SETTINGS,
  inferProjectType,
  parseProjectCatalogText,
  stripJsonComments,
  stripTrailingCommas,
} from './catalogModel';
import { createStoredCatalog, NewStoredProject, StoredProjectCatalog } from './catalogStore';
import { normalizeTodoTagName } from '../todo/todoTags';

export const CATALOG_EXPORT_FORMAT = 'project-butler-export';
export const CATALOG_EXPORT_VERSION = 3;

interface ExportProject {
  readonly alias: string;
  readonly path: string;
  readonly pathKind: 'relative' | 'uri';
  readonly type: 'folder' | 'workspace';
  readonly description?: string;
  readonly tags?: readonly string[];
}

interface ExportCatalog {
  readonly name: string;
  readonly features: StoredProjectCatalog['features'];
  readonly projects: readonly ExportProject[];
}

interface ExportEnvelope {
  readonly format: typeof CATALOG_EXPORT_FORMAT;
  readonly schemaVersion: typeof CATALOG_EXPORT_VERSION;
  readonly exportedAt: string;
  readonly collections: readonly ExportCatalog[];
}

export interface ExportBuildResult {
  readonly text: string;
  readonly portableProjectCount: number;
  readonly nonPortableProjectCount: number;
}

export interface ImportPreview {
  readonly catalogs: readonly StoredProjectCatalog[];
  readonly appliedFieldCount: number;
  readonly defaultedFieldCount: number;
  readonly ignoredFieldCount: number;
  readonly unresolvedProjectCount: number;
  readonly messages: readonly string[];
  readonly sourceKind: 'export' | 'legacy';
}

export function createExportText(
  catalogs: readonly StoredProjectCatalog[],
  exportUri: vscode.Uri,
): ExportBuildResult {
  let portableProjectCount = 0;
  let nonPortableProjectCount = 0;
  const collections: ExportCatalog[] = catalogs.map((catalog) => ({
    name: catalog.name,
    features: catalog.features,
    projects: catalog.projects.map((project): ExportProject => {
      const projectUri = vscode.Uri.parse(project.uri);
      const relative = createRelativePath(exportUri, projectUri);
      if (relative === undefined) {
        nonPortableProjectCount += 1;
      } else {
        portableProjectCount += 1;
      }
      return {
        alias: project.alias,
        path: relative ?? project.uri,
        pathKind: relative === undefined ? 'uri' : 'relative',
        type: project.type,
        ...(project.description === undefined ? {} : { description: project.description }),
        ...(project.tags.length === 0 ? {} : { tags: project.tags }),
      };
    }),
  }));
  const envelope: ExportEnvelope = {
    format: CATALOG_EXPORT_FORMAT,
    schemaVersion: CATALOG_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    collections,
  };
  return {
    text: `${JSON.stringify(envelope, undefined, 2)}\n`,
    portableProjectCount,
    nonPortableProjectCount,
  };
}

export function parseImportText(text: string, sourceUri: vscode.Uri): ImportPreview {
  let raw: unknown;
  try {
    raw = JSON.parse(stripTrailingCommas(stripJsonComments(text))) as unknown;
  } catch (error) {
    throw new Error(`导入文件不是有效 JSON/JSONC：${error instanceof Error ? error.message : String(error)}`);
  }
  if (isRecord(raw) && raw.format === CATALOG_EXPORT_FORMAT) {
    return parseExportEnvelope(raw, sourceUri);
  }
  return parseLegacyCatalog(text, sourceUri);
}

function parseExportEnvelope(raw: Record<string, unknown>, sourceUri: vscode.Uri): ImportPreview {
  if (!Array.isArray(raw.collections)) {
    throw new Error('导出文件缺少 collections 数组。');
  }
  const messages: string[] = [];
  let appliedFieldCount = 0;
  let defaultedFieldCount = 0;
  let ignoredFieldCount = 0;
  let unresolvedProjectCount = 0;
  const legacyRequiredFeatures = raw.schemaVersion === 1;
  if (raw.schemaVersion !== CATALOG_EXPORT_VERSION) {
    messages.push(`导出格式版本为 ${String(raw.schemaVersion)}，当前按已知字段尽力导入。`);
  }
  const catalogs: StoredProjectCatalog[] = [];
  for (const [catalogIndex, value] of raw.collections.entries()) {
    if (!isRecord(value)) {
      ignoredFieldCount += 1;
      messages.push(`集合 #${catalogIndex + 1} 结构无效，已忽略。`);
      continue;
    }
    const name = readString(value.name) ?? `导入集合 ${catalogIndex + 1}`;
    if (readString(value.name) === undefined) {
      defaultedFieldCount += 1;
    } else {
      appliedFieldCount += 1;
    }
    const rawFeatures = isRecord(value.features) ? value.features : {};
    const rawTabs = isRecord(rawFeatures.tabs) ? rawFeatures.tabs : {};
    const hasValidAutoOrganize = typeof rawTabs.autoOrganize === 'boolean';
    const autoOrganize = hasValidAutoOrganize
      ? rawTabs.autoOrganize as boolean
      : legacyRequiredFeatures ? DEFAULT_CATALOG_TAB_SETTINGS.autoOrganize : undefined;
    if (hasValidAutoOrganize || (!legacyRequiredFeatures && rawTabs.autoOrganize === undefined)) {
      appliedFieldCount += 1;
    } else {
      defaultedFieldCount += 1;
      if (!legacyRequiredFeatures) {
        messages.push(`集合“${name}”的标签覆盖值无效，已改为跟随个人默认。`);
      }
    }
    const rawOutline = isRecord(rawFeatures.symbolOutline) ? rawFeatures.symbolOutline : {};
    const explicitMode = rawOutline.mode === 'native' || rawOutline.mode === 'enhanced' || rawOutline.mode === 'both'
      ? rawOutline.mode
      : undefined;
    const mode = explicitMode ?? (legacyRequiredFeatures ? DEFAULT_CATALOG_SYMBOL_OUTLINE_SETTINGS.mode : undefined);
    if (explicitMode !== undefined || (!legacyRequiredFeatures && rawOutline.mode === undefined)) {
      appliedFieldCount += 1;
    } else {
      defaultedFieldCount += 1;
      if (!legacyRequiredFeatures) {
        messages.push(`集合“${name}”的函数大纲覆盖值无效，已改为跟随个人默认。`);
      }
    }
    const todoResult = parseTodoOverrides(rawFeatures.todo, name);
    appliedFieldCount += todoResult.appliedFieldCount;
    defaultedFieldCount += todoResult.defaultedFieldCount;
    messages.push(...todoResult.messages);
    const projects: NewStoredProject[] = [];
    if (!Array.isArray(value.projects)) {
      defaultedFieldCount += 1;
      messages.push(`集合“${name}”缺少有效 projects，已使用空项目列表。`);
    } else {
      for (const [projectIndex, projectValue] of value.projects.entries()) {
        if (!isRecord(projectValue)) {
          ignoredFieldCount += 1;
          messages.push(`集合“${name}”的项目 #${projectIndex + 1} 无效，已忽略。`);
          continue;
        }
        const alias = readString(projectValue.alias);
        const projectPath = readString(projectValue.path);
        const type = projectValue.type === 'workspace' ? 'workspace' : projectValue.type === 'folder' ? 'folder' : undefined;
        if (alias === undefined || projectPath === undefined || type === undefined) {
          ignoredFieldCount += 1;
          messages.push(`集合“${name}”的项目 #${projectIndex + 1} 缺少 alias/path/type，已忽略。`);
          continue;
        }
        let projectUri: vscode.Uri;
        if (projectValue.pathKind === 'uri') {
          try {
            projectUri = vscode.Uri.parse(projectPath, true);
          } catch {
            ignoredFieldCount += 1;
            messages.push(`项目“${alias}”的 URI 无效，已忽略。`);
            continue;
          }
        } else {
          projectUri = vscode.Uri.joinPath(sourceUri, '..', ...projectPath.split('/'));
        }
        const description = readString(projectValue.description);
        projects.push({
          alias,
          uri: projectUri.toString(),
          type,
          ...(description === undefined ? {} : { description }),
          tags: readTags(projectValue.tags),
        });
        appliedFieldCount += 3;
        if (!isLikelyAvailable(projectUri)) {
          unresolvedProjectCount += 1;
        }
      }
    }
    const catalog = createStoredCatalog(name, projects);
    catalogs.push({
      ...catalog,
      features: {
        tabs: autoOrganize === undefined ? {} : { autoOrganize },
        symbolOutline: mode === undefined ? {} : { mode },
        todo: todoResult.todo,
      },
    });
  }
  return {
    catalogs,
    appliedFieldCount,
    defaultedFieldCount,
    ignoredFieldCount,
    unresolvedProjectCount,
    messages,
    sourceKind: 'export',
  };
}

function parseLegacyCatalog(text: string, sourceUri: vscode.Uri): ImportPreview {
  const legacy = parseProjectCatalogText(text);
  if (legacy.compatibility === 'invalid') {
    throw new Error(legacy.issues.map((issue) => issue.message).join('；'));
  }
  const messages = legacy.issues.map((issue) => issue.message);
  let ignoredFieldCount = 0;
  const projects: NewStoredProject[] = [];
  for (const project of legacy.projects) {
    if (project.path.length === 0 || project.issues.some((issue) => issue.severity === 'error')) {
      ignoredFieldCount += 1;
      continue;
    }
    const projectUri = vscode.Uri.joinPath(sourceUri, '..', ...project.path.split('/'));
    projects.push({
      alias: project.alias,
      uri: projectUri.toString(),
      type: inferProjectType(project.path, project.type),
      ...(project.description === undefined ? {} : { description: project.description }),
      tags: project.tags,
    });
  }
  const catalog = createStoredCatalog(legacy.name ?? path.posix.basename(sourceUri.path, '.project-butler.json'), projects);
  return {
    catalogs: [{
      ...catalog,
      features: {
        tabs: legacy.features.tabs,
        symbolOutline: legacy.features.symbolOutline,
        todo: {},
      },
    }],
    appliedFieldCount: projects.length * 3 + 3,
    defaultedFieldCount: legacy.issues.filter((issue) => issue.severity === 'warning').length,
    ignoredFieldCount,
    unresolvedProjectCount: 0,
    messages,
    sourceKind: 'legacy',
  };
}

function parseTodoOverrides(raw: unknown, catalogName: string): {
  readonly todo: StoredProjectCatalog['features']['todo'];
  readonly appliedFieldCount: number;
  readonly defaultedFieldCount: number;
  readonly messages: readonly string[];
} {
  if (raw === undefined) {
    return { todo: {}, appliedFieldCount: 3, defaultedFieldCount: 0, messages: [] };
  }
  if (!isRecord(raw)) {
    return {
      todo: {}, appliedFieldCount: 0, defaultedFieldCount: 3,
      messages: [`集合“${catalogName}”的代码 TODO 配置无效，全部字段已改为跟随个人默认。`],
    };
  }
  const todo: { enabled?: boolean; tags?: readonly string[]; markdownTasks?: boolean } = {};
  const messages: string[] = [];
  let appliedFieldCount = 0;
  let defaultedFieldCount = 0;
  if (raw.enabled === undefined || typeof raw.enabled === 'boolean') {
    appliedFieldCount += 1;
    if (typeof raw.enabled === 'boolean') todo.enabled = raw.enabled;
  } else {
    defaultedFieldCount += 1;
    messages.push(`集合“${catalogName}”的代码 TODO enabled 无效，已改为跟随个人默认。`);
  }
  const tags = readTodoTags(raw.tags);
  if (raw.tags === undefined || tags !== undefined) {
    appliedFieldCount += 1;
    if (tags !== undefined) todo.tags = tags;
  } else {
    defaultedFieldCount += 1;
    messages.push(`集合“${catalogName}”的代码 TODO tags 无效，已改为跟随个人默认。`);
  }
  if (raw.markdownTasks === undefined || typeof raw.markdownTasks === 'boolean') {
    appliedFieldCount += 1;
    if (typeof raw.markdownTasks === 'boolean') todo.markdownTasks = raw.markdownTasks;
  } else {
    defaultedFieldCount += 1;
    messages.push(`集合“${catalogName}”的代码 TODO markdownTasks 无效，已改为跟随个人默认。`);
  }
  return { todo, appliedFieldCount, defaultedFieldCount, messages };
}

function readTodoTags(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const normalized = value.map(normalizeTodoTagName);
  if (normalized.some((item) => item === undefined)) return undefined;
  return [...new Set(normalized as string[])];
}

function createRelativePath(exportUri: vscode.Uri, projectUri: vscode.Uri): string | undefined {
  if (exportUri.scheme !== projectUri.scheme || exportUri.authority !== projectUri.authority) {
    return undefined;
  }
  let relative: string;
  if (exportUri.scheme === 'file') {
    relative = path.relative(path.dirname(exportUri.fsPath), projectUri.fsPath);
    if (path.isAbsolute(relative)) {
      return undefined;
    }
    relative = relative.replace(/\\/gu, '/');
  } else {
    relative = path.posix.relative(path.posix.dirname(exportUri.path), projectUri.path);
  }
  return relative.length === 0 ? '.' : relative.startsWith('.') ? relative : `./${relative}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readTags(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
}

function isLikelyAvailable(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || uri.scheme === 'vscode-remote';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
