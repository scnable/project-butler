import * as vscode from 'vscode';
import { IconSemantic, resolveIconResource } from './iconSemantics';

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

function toExtensionUri(extensionUri: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, ...relativePath.split('/'));
}
