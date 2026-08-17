import * as path from 'node:path';
import * as vscode from 'vscode';

export function isUri(value: unknown): value is vscode.Uri {
  return value instanceof vscode.Uri;
}

export function collectSelectedUris(primary: unknown, selected: unknown): vscode.Uri[] {
  const candidates: vscode.Uri[] = [];

  if (Array.isArray(selected)) {
    for (const value of selected) {
      if (isUri(value)) {
        candidates.push(value);
      }
    }
  }

  if (isUri(primary)) {
    candidates.push(primary);
  }

  const unique = new Map<string, vscode.Uri>();
  for (const uri of candidates) {
    unique.set(uri.toString(), uri);
  }

  return [...unique.values()];
}

export function getWorkspaceRelativePath(
  workspaceFolder: vscode.WorkspaceFolder,
  resource: vscode.Uri,
): string | undefined {
  if (
    workspaceFolder.uri.scheme !== resource.scheme
    || workspaceFolder.uri.authority !== resource.authority
  ) {
    return undefined;
  }

  const relativePath = resource.scheme === 'file'
    ? path.relative(
      path.resolve(workspaceFolder.uri.fsPath),
      path.resolve(resource.fsPath),
    ).replace(/\\/g, '/')
    : path.posix.relative(workspaceFolder.uri.path, resource.path);
  if (
    relativePath.length === 0
    || relativePath === '..'
    || relativePath.startsWith('../')
    || path.posix.isAbsolute(relativePath)
    || path.isAbsolute(relativePath)
  ) {
    return undefined;
  }

  return relativePath;
}

export function getUriDisplayPath(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
}
