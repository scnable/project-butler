import * as vscode from 'vscode';

export type TodoScanBackend = 'currentFile' | 'git' | 'ripgrep' | 'vscode' | 'mixed';

export interface TodoCandidateSearchResult {
  readonly backend: Exclude<TodoScanBackend, 'currentFile' | 'vscode' | 'mixed'>;
  readonly relativePaths: readonly string[];
}

export interface TodoCandidateSearch {
  search(
    folder: vscode.WorkspaceFolder,
    terms: readonly string[],
    excludePatterns: readonly string[],
    token: vscode.CancellationToken,
  ): Promise<TodoCandidateSearchResult | undefined>;
}

export function combineTodoScanBackends(backends: readonly TodoScanBackend[]): TodoScanBackend {
  const unique = [...new Set(backends)];
  if (unique.length === 0) return 'vscode';
  return unique.length === 1 ? unique[0]! : 'mixed';
}

export function todoScanBackendLabel(backend: TodoScanBackend | undefined): string {
  switch (backend) {
    case 'currentFile': return '当前文件';
    case 'git': return 'Git 快速搜索';
    case 'ripgrep': return 'ripgrep 快速搜索';
    case 'mixed': return '混合搜索';
    default: return '兼容扫描';
  }
}
