import * as vscode from 'vscode';
import { IconSemantic, resolveIconResource } from './iconSemantics';
import { IconStyle, normalizeIconStyle } from './iconStyle';

export interface TreeIconPath {
  readonly light: vscode.Uri;
  readonly dark: vscode.Uri;
}

export function createTreeIconPath(
  extensionUri: vscode.Uri,
  semantic: IconSemantic,
): TreeIconPath {
  const light = resolveIconResource(semantic, 'light');
  const dark = resolveIconResource(semantic, 'dark');
  return {
    light: toExtensionUri(extensionUri, light.relativePath),
    dark: toExtensionUri(extensionUri, dark.relativePath),
  };
}

export function getConfiguredIconStyle(): IconStyle {
  return normalizeIconStyle(
    vscode.workspace.getConfiguration('projectManager.visuals').get<unknown>('iconStyle'),
  );
}

export function createTreeIcon(
  extensionUri: vscode.Uri | undefined,
  semantic: IconSemantic,
  nativeFallback: string,
  style: IconStyle = getConfiguredIconStyle(),
): vscode.ThemeIcon | TreeIconPath {
  return extensionUri === undefined || style === 'native'
    ? new vscode.ThemeIcon(nativeFallback)
    : createTreeIconPath(extensionUri, semantic);
}

function toExtensionUri(extensionUri: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, ...relativePath.split('/'));
}
