import * as vscode from 'vscode';
import { createTodoExcludeGlob } from './todoScanPlan';
import { createTodoParseOptionsForPath, getTodoSettings } from './todoSettings';
import { TODO_CACHE_MAX_FILES, TodoFileStamp } from './todoPersistentCache';

export interface TodoInventory {
  readonly stamps: Map<string, TodoFileStamp>;
  readonly complete: boolean;
}

/** 列出所有支持的文件而非仅有标记的文件；每批只发出八个 stat 请求并主动让出事件循环。 */
export async function collectTodoInventory(token: vscode.CancellationToken, filesApi: Pick<vscode.FileSystem, 'stat'> = vscode.workspace.fs): Promise<TodoInventory> {
  const stamps = new Map<string, TodoFileStamp>();
  let complete = true;
  let discovered = 0;
  const settings = getTodoSettings();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (token.isCancellationRequested) return { stamps, complete: false };
    const exclude = createTodoExcludeGlob(
      vscode.workspace.getConfiguration('files', folder.uri).get('exclude'),
      vscode.workspace.getConfiguration('search', folder.uri).get('exclude'),
    );
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'),
      new vscode.RelativePattern(folder, exclude), TODO_CACHE_MAX_FILES - discovered + 1, token);
    discovered += files.length;
    if (discovered > TODO_CACHE_MAX_FILES) return { stamps, complete: false };
    const supported = files.filter((uri) => createTodoParseOptionsForPath(uri.path, settings) !== undefined);
    for (let offset = 0; offset < supported.length; offset += 8) {
      if (token.isCancellationRequested) return { stamps, complete: false };
      await Promise.all(supported.slice(offset, offset + 8).map(async (uri) => {
        try {
          const stamp = await filesApi.stat(uri);
          if (stamp.type === vscode.FileType.File) stamps.set(uri.toString(), {
            mtime: stamp.mtime, ctime: stamp.ctime, size: stamp.size,
          });
        } catch { complete = false; }
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return { stamps, complete: complete && !token.isCancellationRequested };
}

export function todoCacheSignature(): string {
  const settings = getTodoSettings();
  return JSON.stringify({
    parserVersion: 1, enabled: settings.enabled, tags: settings.tagNames,
    markdownTasks: settings.markdownTasks, owners: settings.ownerIdentities,
    project: settings.showProjectMarkers, locale: vscode.env.language,
    roots: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      uri: folder.uri.toString(),
      files: ['exclude', 'encoding', 'associations'].map((key) => vscode.workspace.getConfiguration('files', folder.uri).get(key)),
      search: vscode.workspace.getConfiguration('search', folder.uri).get('exclude'),
    })),
  });
}
