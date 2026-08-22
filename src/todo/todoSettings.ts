import * as vscode from 'vscode';
import { getTodoCommentSyntax, inferTodoLanguageId } from './todoCommentSyntax';
import { createTodoTagDefinitions, normalizeTodoTagNames } from './todoTags';
import { normalizeTodoOwner, normalizeTodoOwners } from './todoOwner';
import { TodoParseOptions, TodoTagDefinition } from './todoTypes';

export interface TodoSettings {
  readonly enabled: boolean;
  readonly tags: readonly TodoTagDefinition[];
  readonly tagNames: readonly string[];
  readonly markdownTasks: boolean;
  readonly highlight: boolean;
  readonly owner?: string;
  readonly ownerAliases: readonly string[];
  readonly ownerIdentities: readonly string[];
  readonly sources: TodoEffectiveSources;
}

export interface CatalogTodoSettings {
  readonly enabled: boolean;
  readonly tags: readonly string[];
  readonly markdownTasks: boolean;
}

export type CatalogTodoOverrides = Partial<CatalogTodoSettings>;
export type TodoSettingSource = '工作区覆盖' | '项目集合' | '全局个人设置' | '插件默认值';

export interface TodoEffectiveSources {
  readonly enabled: TodoSettingSource;
  readonly tags: TodoSettingSource;
  readonly markdownTasks: TodoSettingSource;
}

export interface TodoFeatureConfigurationSource {
  readonly currentProjectTodoSettings: CatalogTodoOverrides | undefined;
}

let featureSource: TodoFeatureConfigurationSource | undefined;

export function bindTodoFeatureConfigurationSource(source: TodoFeatureConfigurationSource): vscode.Disposable {
  featureSource = source;
  return { dispose() { if (featureSource === source) featureSource = undefined; } };
}

export function getTodoSettings(catalogSettings = featureSource?.currentProjectTodoSettings): TodoSettings {
  const configuration = vscode.workspace.getConfiguration('projectManager.todo');
  const enabled = resolveSetting(configuration, 'enabled', catalogSettings?.enabled, true, isBoolean);
  const tags = resolveSetting(configuration, 'tags', catalogSettings?.tags, normalizeTodoTagNames(undefined), isTagList);
  const markdownTasks = resolveSetting(configuration, 'markdownTasks', catalogSettings?.markdownTasks, true, isBoolean);
  const tagNames = normalizeTodoTagNames(tags.value);
  const owner = normalizeTodoOwner(configuration.get<unknown>('owner'));
  const ownerAliases = normalizeTodoOwners(undefined, configuration.get<unknown>('ownerAliases'));
  return {
    enabled: enabled.value,
    tags: createTodoTagDefinitions(tagNames),
    tagNames,
    markdownTasks: markdownTasks.value,
    highlight: configuration.get<boolean>('highlight', true),
    ...(owner === undefined ? {} : { owner }),
    ownerAliases,
    ownerIdentities: normalizeTodoOwners(owner, ownerAliases),
    sources: { enabled: enabled.source, tags: tags.source, markdownTasks: markdownTasks.source },
  };
}

function resolveSetting<T>(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  catalogValue: T | undefined,
  defaultValue: T,
  valid: (value: unknown) => value is T,
): { readonly value: T; readonly source: TodoSettingSource } {
  const inspected = configuration.inspect<unknown>(key);
  const workspaceValue = inspected?.workspaceFolderValue ?? inspected?.workspaceValue;
  if (valid(workspaceValue)) return { value: workspaceValue, source: '工作区覆盖' };
  if (valid(catalogValue)) return { value: catalogValue, source: '项目集合' };
  const globalValue = inspected?.globalValue;
  if (valid(globalValue)) return { value: globalValue, source: '全局个人设置' };
  return { value: defaultValue, source: '插件默认值' };
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isTagList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
}

export function createTodoParseOptions(languageId: string | undefined, settings = getTodoSettings()): TodoParseOptions | undefined {
  if (languageId === 'markdown') {
    return { tags: settings.tags, markdownTasks: settings.markdownTasks, lineCommentTokens: [], blockCommentTokens: [] };
  }
  const syntax = languageId === undefined ? undefined : getTodoCommentSyntax(languageId);
  return syntax === undefined ? undefined : {
    tags: settings.tags,
    markdownTasks: false,
    lineCommentTokens: syntax.lineTokens,
    blockCommentTokens: syntax.blockTokens,
  };
}

export function createTodoParseOptionsForPath(path: string, settings = getTodoSettings()): TodoParseOptions | undefined {
  return createTodoParseOptions(inferTodoLanguageId(path), settings);
}
