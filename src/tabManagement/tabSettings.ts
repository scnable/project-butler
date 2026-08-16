import * as vscode from 'vscode';
import {
  CatalogTabSettings,
  DEFAULT_CATALOG_TAB_SETTINGS,
} from '../projectCatalog/catalogModel';

export type TabSettingSource = '工作区覆盖' | '项目集合' | '全局个人设置' | '旧版个人设置' | '插件默认值';

export interface EffectiveTabSettings {
  readonly values: CatalogTabSettings;
  readonly sources: {
    readonly autoOrganize: TabSettingSource;
  };
}

export function resolveEffectiveTabSettings(
  catalogSettings: CatalogTabSettings | undefined,
): EffectiveTabSettings {
  const configuration = vscode.workspace.getConfiguration('projectManager.tabs');
  const inspected = configuration.inspect<boolean>('autoOrganize');
  const workspaceAutoOrganize = inspected?.workspaceFolderValue ?? inspected?.workspaceValue;
  const globalAutoOrganize = inspected?.globalValue;
  const legacyMode = getExplicitValue<string>(
    vscode.workspace.getConfiguration('projectManager.tabs.grouping'),
    'action',
  );
  const legacyAutoOrganize = legacyMode === undefined ? undefined : legacyMode === 'auto';
  const value = workspaceAutoOrganize
    ?? catalogSettings?.autoOrganize
    ?? globalAutoOrganize
    ?? legacyAutoOrganize
    ?? DEFAULT_CATALOG_TAB_SETTINGS.autoOrganize;
  const source: TabSettingSource = workspaceAutoOrganize !== undefined
    ? '工作区覆盖'
    : catalogSettings !== undefined
      ? '项目集合'
      : globalAutoOrganize !== undefined
        ? '全局个人设置'
        : legacyAutoOrganize !== undefined
          ? '旧版个人设置'
          : '插件默认值';
  return {
    values: {
      autoOrganize: value,
    },
    sources: {
      autoOrganize: source,
    },
  };
}

function getExplicitValue<T>(configuration: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const inspected = configuration.inspect<T>(key);
  return inspected?.workspaceFolderValue
    ?? inspected?.workspaceValue
    ?? inspected?.globalValue;
}
