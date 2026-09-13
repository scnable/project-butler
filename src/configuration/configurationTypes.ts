/**
 * 跨功能的配置接口：标签、增强大纲和 TODO 通过它读取集合覆盖值，不直接操作集合存储。
 * undefined 表示没有该项集合覆盖，不代表功能关闭；最终取值由各功能的 settings 模块决定。
 * onDidChange 通知来源状态发生变化，消费者仍需比较有效配置，不能每次通知都重做昂贵操作。
 */
import * as vscode from 'vscode';
import { CatalogSymbolOutlineSettings, CatalogTabSettings } from '../projectCatalog/catalogModel';
import { CatalogTodoOverrides } from '../todo/todoSettings';

export type ProjectConfigurationContext =
  | { readonly kind: 'member'; readonly project: { readonly alias: string } }
  | { readonly kind: 'external' }
  | { readonly kind: 'noWorkspace' };

/**
 * 标签整理、函数大纲和代码 TODO 只依赖这一小块契约，不再依赖项目集合的存储实现。
 */
export interface ProjectFeatureConfigurationSource {
  readonly onDidChange: vscode.Event<unknown>;
  readonly projectContext: ProjectConfigurationContext;
  readonly currentProjectTabSettings: CatalogTabSettings | undefined;
  readonly currentProjectSymbolOutlineSettings: CatalogSymbolOutlineSettings | undefined;
  readonly currentProjectTodoSettings: CatalogTodoOverrides | undefined;
  updateCurrentOutlineMode(mode: 'native' | 'enhanced' | 'both'): Promise<boolean>;
  updateCurrentTodoSetting(key: 'enabled' | 'markdownTasks', value: boolean | undefined, showFeedback?: boolean): Promise<boolean>;
  updateCurrentTodoTags(tags: readonly string[] | undefined, showFeedback?: boolean): Promise<boolean>;
}
