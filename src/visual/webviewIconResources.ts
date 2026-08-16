import * as vscode from 'vscode';
import {
  IconSemantic,
  resolveIconResource,
} from './iconSemantics';

export interface WebviewIconResourceSet {
  readonly monochrome: string;
  readonly light: string;
  readonly dark: string;
  readonly monochromeOnly: boolean;
}

export type WebviewIconResourceMap = Readonly<Record<string, WebviewIconResourceSet>>;

export function getIconResourceRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media', 'icons');
}

export function createWebviewIconResourceMap(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  semantics: readonly IconSemantic[],
): WebviewIconResourceMap {
  const uniqueSemantics = new Set(semantics);
  return Object.fromEntries([...uniqueSemantics].map((semantic) => {
    const monochrome = resolveIconResource(semantic, 'monochrome');
    const light = resolveIconResource(semantic, 'light');
    const dark = resolveIconResource(semantic, 'dark');
    return [semantic, {
      monochrome: toWebviewUri(webview, extensionUri, monochrome.relativePath),
      light: toWebviewUri(webview, extensionUri, light.relativePath),
      dark: toWebviewUri(webview, extensionUri, dark.relativePath),
      monochromeOnly: light.theme === 'monochrome' && dark.theme === 'monochrome',
    }];
  }));
}

function toWebviewUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  relativePath: string,
): string {
  return webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, ...relativePath.split('/')),
  ).toString();
}
