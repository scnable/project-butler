import * as vscode from 'vscode';
import { escapeGlobPath } from '../exclusions/exclusionPatterns';
import { TodoIndex } from './todoIndex';
import { LocalTodoCandidateSearch } from './todoLocalSearch';
import { parseTodoText } from './todoParser';
import { collectTodoExcludePatterns, createTodoExcludeGlob, createTodoSearchQuery, normalizeTodoCandidatePath } from './todoScanPlan';
import { combineTodoScanBackends, TodoCandidateSearch, TodoScanBackend } from './todoSearchBackend';
import { createTodoParseOptions, createTodoParseOptionsForPath, getTodoSettings } from './todoSettings';
import { runTodoScanEngine, TODO_SCAN_CONCURRENCY, TODO_SCAN_MAX_RESULTS, TodoScanEngineProgress } from './todoScanEngine';
import { isMyTodoOwner } from './todoOwner';
import { TodoMatch } from './todoTypes';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 150;

export interface TodoScanSummary {
  readonly files: number;
  readonly candidateFiles: number;
  readonly discoveredFiles: number;
  readonly skippedFiles: number;
  readonly results: number;
  readonly truncated: boolean;
  readonly cancelled: boolean;
  readonly phase: 'openFiles' | 'discovering' | 'scanning' | 'complete' | 'failed';
  readonly backend: TodoScanBackend;
  readonly limit?: 'results';
  readonly error?: string;
  readonly stale?: boolean;
}

interface TodoCandidateDiscovery {
  readonly uris: readonly vscode.Uri[];
  readonly discoveredFiles: number;
  readonly backend: TodoScanBackend;
}

export class TodoScanner {
  private revision = 0;

  public constructor(
    public readonly index: TodoIndex,
    private readonly output: vscode.OutputChannel,
    private readonly candidateSearch: TodoCandidateSearch = new LocalTodoCandidateSearch(),
  ) {}

  public scanDocument(document: vscode.TextDocument): void {
    const settings = getTodoSettings();
    const options = createTodoParseOptions(document.languageId, settings);
    if (!settings.enabled || options === undefined) {
      this.index.remove(document.uri.toString());
      return;
    }
    const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
    this.index.replace(
      document.uri.toString(),
      parseTodoText(document.getText(), options),
      ++this.revision,
      workspace === undefined ? document.uri.path.split('/').pop() ?? document.uri.toString() : vscode.workspace.asRelativePath(document.uri, false),
      workspace?.uri.toString(),
    );
  }

  public async scanCurrentFile(token: vscode.CancellationToken): Promise<TodoScanSummary> {
    this.index.clear();
    const document = vscode.window.activeTextEditor?.document;
    if (document === undefined || token.isCancellationRequested) {
      return {
        files: 0, candidateFiles: 0, discoveredFiles: 0, skippedFiles: 0, results: 0,
        truncated: false, cancelled: token.isCancellationRequested, phase: 'complete', backend: 'currentFile',
      };
    }
    this.scanDocument(document);
    return {
      files: 1,
      candidateFiles: 1,
      discoveredFiles: 1,
      skippedFiles: 0,
      results: this.index.get(document.uri.toString())?.matches.length ?? 0,
      truncated: false,
      cancelled: token.isCancellationRequested,
      phase: 'complete',
      backend: 'currentFile',
    };
  }

  public async scanUri(uri: vscode.Uri): Promise<boolean> {
    const settings = getTodoSettings();
    const workspace = vscode.workspace.getWorkspaceFolder(uri);
    if (workspace !== undefined && !(await this.isIncludedWorkspaceUri(uri, workspace))) {
      return this.index.remove(uri.toString());
    }
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    const options = openDocument === undefined
      ? createTodoParseOptionsForPath(uri.path, settings)
      : createTodoParseOptions(openDocument.languageId, settings);
    if (!settings.enabled || options === undefined) return this.index.remove(uri.toString());
    try {
      const text = openDocument?.getText() ?? await this.readText(uri);
      if (text === undefined) return false;
      return this.index.replace(
        uri.toString(), parseTodoText(text, options), ++this.revision,
        workspace === undefined ? uri.path.split('/').pop() ?? uri.toString() : vscode.workspace.asRelativePath(uri, false),
        workspace?.uri.toString(),
      );
    } catch (error) {
      this.output.appendLine(`TODO 增量扫描跳过 ${uri.path.split('/').pop() ?? '未知文件'}：${error instanceof Error ? error.name : '读取失败'}`);
      return false;
    }
  }

  public async scanWorkspace(
    token: vscode.CancellationToken,
    onProgress?: (summary: TodoScanSummary) => void,
  ): Promise<TodoScanSummary> {
    const scanRevision = ++this.revision;
    const previousSnapshot = this.index.snapshot();
    this.index.clear();
    const settings = getTodoSettings();
    if (!settings.enabled) {
      return {
        files: 0, candidateFiles: 0, discoveredFiles: 0, skippedFiles: 0, results: 0,
        truncated: false, cancelled: false, phase: 'complete', backend: 'vscode',
      };
    }
    if (!settings.showProjectMarkers && settings.ownerIdentities.length === 0) {
      return {
        files: 0, candidateFiles: 0, discoveredFiles: 0, skippedFiles: 0, results: 0,
        truncated: false, cancelled: token.isCancellationRequested, phase: 'complete', backend: 'vscode',
      };
    }
    const seededUris = this.seedOpenDocuments(settings, scanRevision);
    if (seededUris.length > 0) {
      onProgress?.({
        files: seededUris.length,
        candidateFiles: seededUris.length,
        discoveredFiles: seededUris.length,
        skippedFiles: 0,
        results: this.countResults(),
        truncated: false,
        cancelled: token.isCancellationRequested,
        phase: 'openFiles',
        backend: 'vscode',
      });
    }
    onProgress?.({
      files: 0, candidateFiles: 0, discoveredFiles: 0, skippedFiles: 0, results: this.countResults(),
      truncated: false, cancelled: token.isCancellationRequested, phase: 'discovering', backend: 'vscode',
    });
    let discovery: TodoCandidateDiscovery;
    try {
      discovery = await this.findCandidateUris(settings, token);
    } catch (error) {
      return this.restoreFailedScan(previousSnapshot, error, 'vscode');
    }
    const uris = discovery.uris;
    const candidateKeys = new Set(uris.map((uri) => uri.toString()));
    for (const uri of seededUris) {
      if (!candidateKeys.has(uri.toString())) this.index.remove(uri.toString());
    }
    let lastProgressAt = 0;
    const openDocuments = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]));

    let personalResults = 0;
    let projectResults = 0;
    let personalTruncated = false;
    let projectTruncated = false;
    const acceptMatches = (matches: readonly TodoMatch[]): TodoMatch[] => {
      const accepted: TodoMatch[] = [];
      for (const match of matches) {
        const mine = isMyTodoOwner(match.owner, settings.ownerIdentities);
        const current = mine ? personalResults : projectResults;
        if (current >= TODO_SCAN_MAX_RESULTS) {
          if (mine) personalTruncated = true;
          else projectTruncated = true;
          continue;
        }
        accepted.push(match);
        if (mine) personalResults += 1;
        else projectResults += 1;
      }
      return accepted;
    };
    const summary = (progress: TodoScanEngineProgress, phase: TodoScanSummary['phase'] = 'scanning'): TodoScanSummary => ({
      files: progress.files,
      candidateFiles: uris.length,
      discoveredFiles: discovery.discoveredFiles,
      skippedFiles: progress.skippedFiles,
      results: progress.results,
      truncated: progress.truncated || personalTruncated || projectTruncated,
      cancelled: progress.cancelled,
      phase,
      backend: discovery.backend,
      ...(progress.truncated || personalTruncated || projectTruncated ? { limit: 'results' as const } : {}),
    });
    const reportProgress = (progress: TodoScanEngineProgress, force = false): void => {
      const now = Date.now();
      if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
      lastProgressAt = now;
      onProgress?.(summary(progress));
    };

    let scanProgress: TodoScanEngineProgress;
    try {
      scanProgress = await runTodoScanEngine({
        items: uris,
        concurrency: TODO_SCAN_CONCURRENCY,
        maxResults: settings.showProjectMarkers ? TODO_SCAN_MAX_RESULTS * 2 : TODO_SCAN_MAX_RESULTS,
        isCancelled: () => token.isCancellationRequested,
        load: async (uri) => {
          const openDocument = openDocuments.get(uri.toString());
          const options = openDocument === undefined
            ? createTodoParseOptionsForPath(uri.path, settings)
            : createTodoParseOptions(openDocument.languageId, settings);
          if (options === undefined) return undefined;
          const text = openDocument?.getText() ?? await this.readText(uri);
          return text === undefined ? undefined : acceptMatches(parseTodoText(text, options));
        },
        commit: (uri, matches) => {
          const workspace = vscode.workspace.getWorkspaceFolder(uri);
          this.index.replace(
            uri.toString(), matches, scanRevision,
            workspace === undefined ? uri.path.split('/').pop() ?? uri.toString() : vscode.workspace.asRelativePath(uri, false),
            workspace?.uri.toString(),
          );
        },
        onSkipped: (uri, error) => {
          if (error === undefined) return;
          this.output.appendLine(`TODO 扫描跳过 ${uri.path.split('/').pop() ?? '未知文件'}：${error instanceof Error ? error.name : '读取失败'}`);
        },
        onProgress: (progress) => reportProgress(progress),
      });
    } catch (error) {
      return this.restoreFailedScan(previousSnapshot, error, discovery.backend, {
        files: 0,
        candidateFiles: uris.length,
        discoveredFiles: discovery.discoveredFiles,
        skippedFiles: 0,
      });
    }
    reportProgress(scanProgress, true);
    return summary(scanProgress, 'complete');
  }

  private async findCandidateUris(
    settings: ReturnType<typeof getTodoSettings>,
    token: vscode.CancellationToken,
  ): Promise<TodoCandidateDiscovery> {
    const roots = vscode.workspace.workspaceFolders ?? [];
    const groups = await Promise.all(roots.map(async (folder) => {
      const excludePatterns = this.collectExcludePatterns(folder);
      const exclude = createTodoExcludeGlob(...this.excludeConfigurations(folder));
      const query = createTodoSearchQuery(
        settings.tagNames, settings.markdownTasks, settings.ownerIdentities, settings.showProjectMarkers,
      );
      const personalQuery = createTodoSearchQuery(settings.tagNames, false, settings.ownerIdentities, false);
      const [fastResult, personalResult] = await Promise.all([
        this.candidateSearch.search(folder, query, excludePatterns, token),
        settings.showProjectMarkers && personalQuery.patterns.length > 0
          ? this.candidateSearch.search(folder, personalQuery, excludePatterns, token)
          : Promise.resolve(undefined),
      ]);
      if (fastResult === undefined) {
        const discovered = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, '**/*'),
          new vscode.RelativePattern(folder, exclude),
          undefined,
          token,
        );
        const supported = discovered.filter((uri) => createTodoParseOptionsForPath(uri.path, settings) !== undefined);
        return { uris: supported, discoveredFiles: supported.length, backend: 'vscode' as const };
      }
      const selected = new Map<string, vscode.Uri>();
      const addCandidate = (relativePath: string): void => {
        const normalized = normalizeTodoCandidatePath(relativePath);
        if (normalized === undefined) return;
        const uri = vscode.Uri.joinPath(folder.uri, ...normalized.split('/'));
        if (createTodoParseOptionsForPath(uri.path, settings) !== undefined) selected.set(uri.toString(), uri);
      };
      for (const path of personalResult?.relativePaths ?? []) addCandidate(path);
      for (const path of fastResult.relativePaths) addCandidate(path);
      for (const document of vscode.workspace.textDocuments) {
        if (vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() !== folder.uri.toString()) continue;
        if (createTodoParseOptions(document.languageId, settings) === undefined) continue;
        if (await this.isIncludedWorkspaceUri(document.uri, folder)) selected.set(document.uri.toString(), document.uri);
      }
      return { uris: [...selected.values()], discoveredFiles: selected.size, backend: fastResult.backend };
    }));
    const unique = new Map<string, vscode.Uri>();
    for (const uri of groups.flatMap((group) => group.uris)) unique.set(uri.toString(), uri);
    return {
      // 个人候选由每个工作区组先插入；保持该顺序，避免大量项目已有标记挤占个人标记的扫描时机。
      uris: [...unique.values()],
      discoveredFiles: groups.reduce((sum, group) => sum + group.discoveredFiles, 0),
      backend: combineTodoScanBackends(groups.map((group) => group.backend)),
    };
  }

  private async isIncludedWorkspaceUri(uri: vscode.Uri, folder: vscode.WorkspaceFolder): Promise<boolean> {
    if (createTodoParseOptionsForPath(uri.path) === undefined) return false;
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    const matches = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, escapeGlobPath(relativePath)),
      new vscode.RelativePattern(folder, this.createExcludePattern(folder)),
      1,
    );
    return matches.some((candidate) => candidate.toString() === uri.toString());
  }

  private createExcludePattern(folder: vscode.WorkspaceFolder): string {
    return createTodoExcludeGlob(...this.excludeConfigurations(folder));
  }

  private excludeConfigurations(folder: vscode.WorkspaceFolder): readonly unknown[] {
    return [
      vscode.workspace.getConfiguration('files', folder.uri).get<unknown>('exclude'),
      vscode.workspace.getConfiguration('search', folder.uri).get<unknown>('exclude'),
    ];
  }

  private collectExcludePatterns(folder: vscode.WorkspaceFolder): string[] {
    return collectTodoExcludePatterns(...this.excludeConfigurations(folder));
  }

  private seedOpenDocuments(settings: ReturnType<typeof getTodoSettings>, revision: number): vscode.Uri[] {
    const uris: vscode.Uri[] = [];
    for (const document of vscode.workspace.textDocuments) {
      const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
      const options = createTodoParseOptions(document.languageId, settings);
      if (workspace === undefined || options === undefined) continue;
      this.index.replace(
        document.uri.toString(), parseTodoText(document.getText(), options), revision,
        vscode.workspace.asRelativePath(document.uri, false), workspace.uri.toString(),
      );
      uris.push(document.uri);
    }
    return uris;
  }

  private countResults(): number {
    return this.index.values().reduce((sum, entry) => sum + entry.matches.length, 0);
  }

  private restoreFailedScan(
    snapshot: ReturnType<TodoIndex['snapshot']>,
    error: unknown,
    backend: TodoScanBackend,
    progress: Pick<TodoScanSummary, 'files' | 'candidateFiles' | 'discoveredFiles' | 'skippedFiles'> = {
      files: 0,
      candidateFiles: 0,
      discoveredFiles: 0,
      skippedFiles: 0,
    },
  ): TodoScanSummary {
    this.index.restore(snapshot);
    return {
      ...progress,
      results: snapshot.entries.reduce((sum, entry) => sum + entry.matches.length, 0),
      truncated: false,
      cancelled: false,
      phase: 'failed',
      backend,
      error: error instanceof Error ? error.name : '未知错误',
      stale: snapshot.entries.length > 0,
    };
  }

  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File || stat.size > MAX_FILE_BYTES) return undefined;
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.includes(0)) return undefined;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }
}
