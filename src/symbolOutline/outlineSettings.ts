import * as vscode from 'vscode';
import {
  CatalogSymbolOutlineSettings,
  DEFAULT_CATALOG_SYMBOL_OUTLINE_SETTINGS,
} from '../projectCatalog/catalogModel';
import { OutlineMode } from './outlineMode';

export type OutlineModeSource = '工作区覆盖' | '项目集合' | '全局个人设置' | '插件默认值';

export interface EffectiveOutlineMode {
  readonly mode: OutlineMode;
  readonly source: OutlineModeSource;
}

export function resolveEffectiveOutlineMode(
  catalogSettings: CatalogSymbolOutlineSettings | undefined,
): EffectiveOutlineMode {
  const configuration = vscode.workspace.getConfiguration('projectManager.symbolOutline');
  const inspected = configuration.inspect<OutlineMode>('mode');
  const workspaceMode = inspected?.workspaceFolderValue ?? inspected?.workspaceValue;
  if (workspaceMode === 'native' || workspaceMode === 'enhanced' || workspaceMode === 'both') {
    return { mode: workspaceMode, source: '工作区覆盖' };
  }
  if (catalogSettings !== undefined) {
    return { mode: catalogSettings.mode, source: '项目集合' };
  }
  const globalMode = inspected?.globalValue;
  if (globalMode === 'native' || globalMode === 'enhanced' || globalMode === 'both') {
    return { mode: globalMode, source: '全局个人设置' };
  }
  return { mode: DEFAULT_CATALOG_SYMBOL_OUTLINE_SETTINGS.mode, source: '插件默认值' };
}
