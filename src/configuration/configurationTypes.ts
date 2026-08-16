import * as vscode from 'vscode';
import { CatalogSymbolOutlineSettings, CatalogTabSettings } from '../projectCatalog/catalogModel';

export type ProjectConfigurationContext =
  | { readonly kind: 'member'; readonly project: { readonly alias: string } }
  | { readonly kind: 'external' }
  | { readonly kind: 'noWorkspace' };

/**
 * 标签整理和函数大纲只依赖这一小块契约，不再依赖项目集合的存储实现。
 */
export interface ProjectFeatureConfigurationSource {
  readonly onDidChange: vscode.Event<unknown>;
  readonly projectContext: ProjectConfigurationContext;
  readonly currentProjectTabSettings: CatalogTabSettings | undefined;
  readonly currentProjectSymbolOutlineSettings: CatalogSymbolOutlineSettings | undefined;
  updateCurrentOutlineMode(mode: 'native' | 'enhanced' | 'both'): Promise<boolean>;
}
