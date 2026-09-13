/**
 * 将候选文件搜索、文件读取和精确标记解析组合为扫描流程，并向唯一 TodoIndex 提交结果。
 * 打开的文档优先使用内存文本，不能用磁盘旧内容覆盖未保存编辑；全量结果先放入临时索引再合并。
 * 搜索后端只缩小候选范围，是否是有效个人标记仍由 todoParser 和身份设置判断。
 * 文件大小、候选数量、结果数和并发限制分别控制不同开销；个人标记扫描也不能取消这些保护。
 */
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
import { collectTodoInventory, todoCacheSignature, TodoInventory } from './todoCacheInventory';
import { decodeTodoCache, encodeTodoCache, sameTodoFileStamp, TODO_CACHE_KEY, TODO_CACHE_MAX_AGE, TODO_CACHE_MAX_FILES, TodoCachedFile, TodoDiskCache } from './todoPersistentCache';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 150;
const MAX_DISCOVERED_FILES = 50_000;

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
  readonly updateKind?: 'full' | 'incremental';
  readonly reusedFiles?: number;
  readonly readFiles?: number;
  /** 按单文件大小策略跳过，不等同于读取失败。 */
  readonly oversizedFiles?: number;
}

interface TodoCandidateDiscovery {
  readonly uris: readonly vscode.Uri[];
  readonly discoveredFiles: number;
  readonly backend: TodoScanBackend;
}

interface TodoTextDecodeResult {
  readonly text: string;
  readonly encoding: string;
  readonly fallback: boolean;
}

export class TodoScanner {
  private revision = 0;
  private diskCache: TodoDiskCache | undefined;
  private readonly invalidatedFiles = new Set<string>();

  public constructor(
    public readonly index: TodoIndex,
    private readonly output: vscode.OutputChannel,
    private readonly candidateSearch: TodoCandidateSearch = new LocalTodoCandidateSearch(),
    private readonly storage?: vscode.Memento,
    private readonly filesApi: Pick<vscode.FileSystem, 'stat' | 'readFile'> = vscode.workspace.fs,
  ) {}

  public restoreCache(): boolean {
    const settings = getTodoSettings();
    if (!settings.enabled || (!settings.showProjectMarkers && settings.ownerIdentities.length === 0)) return false;
    const signature = todoCacheSignature();
    this.diskCache = decodeTodoCache(this.storage?.get(TODO_CACHE_KEY), signature, (value) => {
      const uri = vscode.Uri.parse(value, true);
      return !uri.query && !uri.fragment && !uri.path.split('/').some((part) => part === '..' || part === '.')
        && vscode.workspace.getWorkspaceFolder(uri) !== undefined;
    });
    if (this.diskCache === undefined) return false;
    const restored = new TodoIndex();
    for (const file of this.diskCache.files) {
      const uri = vscode.Uri.parse(file.uri);
      restored.replace(file.uri, file.matches, 0, vscode.workspace.asRelativePath(uri, false),
        vscode.workspace.getWorkspaceFolder(uri)?.uri.toString());
    }
    // 跨启动修订号归零；此前已收到的实时编辑保持优先，不能直接 restore 清空它们。
    this.index.reconcile(restored.snapshot(), 0);
    return true;
  }

  public invalidateCache(): void { this.diskCache = undefined; }

  private invalidateUri(uri: vscode.Uri): void {
    this.invalidatedFiles.add(uri.toString());
    if (this.invalidatedFiles.size > TODO_CACHE_MAX_FILES) {
      this.invalidatedFiles.clear();
      this.diskCache = undefined;
    }
  }

  public async updateWorkspace(token: vscode.CancellationToken, onProgress?: (summary: TodoScanSummary) => void): Promise<TodoScanSummary> {
    const cache = this.diskCache;
    if (!cache || cache.signature !== todoCacheSignature() || Date.now() - cache.fullAt > TODO_CACHE_MAX_AGE) {
      return this.scanWorkspace(token, onProgress);
    }
    const revision = ++this.revision;
    const invalidated = new Set(this.invalidatedFiles);
    this.invalidatedFiles.clear();
    const settings = getTodoSettings();
    this.seedOpenDocuments(settings);
    const base = { files: 0, candidateFiles: 0, discoveredFiles: 0, skippedFiles: 0,
      results: this.countResults(), truncated: false, cancelled: false, backend: 'vscode' as const,
      updateKind: 'incremental' as const };
    onProgress?.({ ...base, phase: 'discovering', stale: true });
    let inventory: TodoInventory;
    try { inventory = await collectTodoInventory(token, this.filesApi); }
    catch (error) { return { ...this.failedScan(error, 'vscode'), updateKind: 'incremental' }; }
    if (!inventory.complete || token.isCancellationRequested) {
      return { ...this.failedScan(new Error('文件清单未完成'), 'vscode'),
        cancelled: token.isCancellationRequested, updateKind: 'incremental', stale: true };
    }
    const previous = new Map(cache.files.map((file) => [file.uri, file]));
    const next = new Map<string, TodoCachedFile>();
    const staging = new TodoIndex();
    let reusedFiles = 0;
    let readFiles = 0;
    let oversizedFiles = 0;
    let personal = 0;
    let project = 0;
    let limited = false;
    let incomplete = false;
    let lastProgress = 0;
    const progress = await runTodoScanEngine({
      items: [...inventory.stamps.entries()], concurrency: 8, maxResults: TODO_SCAN_MAX_RESULTS * 2,
      isCancelled: () => token.isCancellationRequested,
      load: async ([key, stamp]) => {
        const uri = vscode.Uri.parse(key);
        const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === key && !doc.isClosed);
        const old = previous.get(key);
        let matches: readonly TodoMatch[];
        // size 随缓存保存：这是按策略跳过，不是假定文件没有标记；缩小后会走正常读取。
        if (!document && stamp.size > MAX_FILE_BYTES) {
          oversizedFiles += 1;
          next.set(key, { uri: key, ...stamp, matches: [] });
          this.reportOversized(uri);
          if (oversizedFiles % 64 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
          return [];
        } else if (!document && old && !invalidated.has(key) && !this.invalidatedFiles.has(key) && sameTodoFileStamp(old, stamp)) {
          matches = old.matches; reusedFiles += 1;
          next.set(key, old);
        } else {
          const options = document ? createTodoParseOptions(document.languageId, settings) : createTodoParseOptionsForPath(uri.path, settings);
          const text = document?.getText() ?? await this.readText(uri);
          readFiles += 1;
          if (text === undefined || !options) { incomplete = true; return undefined; }
          matches = parseTodoText(text, options);
          if (!document) {
            const after = await this.filesApi.stat(uri);
            if (sameTodoFileStamp(stamp, after)) next.set(key, { uri: key, ...stamp, matches });
            else incomplete = true;
          }
        }
        if ((reusedFiles + readFiles) % 64 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        return matches.filter((match) => {
          const mine = isMyTodoOwner(match.owner, settings.ownerIdentities);
          if ((mine ? personal : project) >= TODO_SCAN_MAX_RESULTS) { limited = true; return false; }
          if (mine) personal += 1; else project += 1;
          return true;
        });
      },
      commit: ([key], matches) => {
        const uri = vscode.Uri.parse(key);
        staging.replace(key, matches, revision, vscode.workspace.asRelativePath(uri, false),
          vscode.workspace.getWorkspaceFolder(uri)?.uri.toString());
      },
      onSkipped: () => { incomplete = true; },
      onProgress: (p) => {
        if (Date.now() - lastProgress < PROGRESS_INTERVAL_MS) return;
        lastProgress = Date.now();
        onProgress?.({ ...base, ...p, candidateFiles: inventory.stamps.size, discoveredFiles: inventory.stamps.size,
          files: Math.max(0, p.files - oversizedFiles), skippedFiles: p.skippedFiles + oversizedFiles,
          phase: 'scanning', reusedFiles, readFiles, oversizedFiles });
      },
    });
    const cancelled = token.isCancellationRequested || progress.cancelled;
    const stale = incomplete || limited || progress.truncated || cancelled || cache.signature !== todoCacheSignature();
    if (!stale) {
      this.index.reconcile(staging.snapshot(), revision);
      await this.saveCache({ ...cache, savedAt: Date.now(), files: [...next.values()] }, token);
    }
    return { ...base, ...progress, phase: incomplete ? 'failed' : 'complete',
      files: Math.max(0, progress.files - oversizedFiles), skippedFiles: progress.skippedFiles + oversizedFiles, oversizedFiles,
      candidateFiles: inventory.stamps.size, discoveredFiles: inventory.stamps.size,
      results: this.countResults(), cancelled, stale, reusedFiles, readFiles,
      truncated: limited || progress.truncated,
      ...(limited || progress.truncated ? { limit: 'results' as const } : {}),
      ...(incomplete ? { error: '部分文件未能校验，已保留历史结果' } : {}) };
  }

  private async saveCache(cache: TodoDiskCache, token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested || cache.signature !== todoCacheSignature()) return;
    // 打开的文件包括未保存内容，不作为下一次启动的磁盘依据。
    const open = new Set(vscode.workspace.textDocuments.filter((doc) => !doc.isClosed).map((doc) => doc.uri.toString()));
    const clean = { ...cache, files: cache.files.filter((file) => !open.has(file.uri) && !this.invalidatedFiles.has(file.uri)) };
    const encoded = encodeTodoCache(clean);
    if (!encoded || !decodeTodoCache(encoded, cache.signature, (value) => vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(value)) !== undefined)) {
      this.diskCache = undefined;
      this.output.appendLine('TODO 缓存超出安全范围，本次不持久化。');
      return;
    }
    this.diskCache = clean;
    try { await this.storage?.update(TODO_CACHE_KEY, encoded); }
    catch { this.output.appendLine('TODO 缓存保存失败，下次启动将重新校验。'); }
  }

  public scanDocument(document: vscode.TextDocument): boolean {
    this.invalidateUri(document.uri);
    const settings = getTodoSettings();
    const options = createTodoParseOptions(document.languageId, settings);
    if (!settings.enabled || options === undefined) {
      return this.index.removeAtRevision(document.uri.toString(), ++this.revision);
    }
    return this.replaceDocument(document, settings, ++this.revision);
  }

  public removeUri(uri: vscode.Uri): boolean {
    this.invalidateUri(uri);
    return this.index.removeAtRevision(uri.toString(), ++this.revision);
  }

  private replaceDocument(
    document: vscode.TextDocument,
    settings: ReturnType<typeof getTodoSettings>,
    revision: number,
  ): boolean {
    const options = createTodoParseOptions(document.languageId, settings);
    if (options === undefined) return this.index.removeAtRevision(document.uri.toString(), revision);
    const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
    return this.index.replace(
      document.uri.toString(),
      parseTodoText(document.getText(), options),
      revision,
      workspace === undefined ? document.uri.path.split('/').pop() ?? document.uri.toString() : vscode.workspace.asRelativePath(document.uri, false),
      workspace?.uri.toString(),
    );
  }

  public async scanCurrentFile(token: vscode.CancellationToken): Promise<TodoScanSummary> {
    const scanRevision = ++this.revision;
    const document = vscode.window.activeTextEditor?.document;
    if (document === undefined || token.isCancellationRequested) {
      if (!token.isCancellationRequested) this.index.reconcile({ entries: [], revisions: [] }, scanRevision);
      return {
        files: 0, candidateFiles: 0, discoveredFiles: 0, skippedFiles: 0, results: 0,
        truncated: false, cancelled: token.isCancellationRequested, phase: 'complete', backend: 'currentFile',
      };
    }
    const staging = new TodoIndex();
    const options = createTodoParseOptions(document.languageId);
    if (options !== undefined) {
      const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
      staging.replace(
        document.uri.toString(), parseTodoText(document.getText(), options), scanRevision,
        workspace === undefined
          ? document.uri.path.split('/').pop() ?? document.uri.toString()
          : vscode.workspace.asRelativePath(document.uri, false),
        workspace?.uri.toString(),
      );
    }
    if (!token.isCancellationRequested) this.index.reconcile(staging.snapshot(), scanRevision);
    return {
      files: 1,
      candidateFiles: 1,
      discoveredFiles: 1,
      skippedFiles: 0,
      results: token.isCancellationRequested ? this.countResults() : this.index.get(document.uri.toString())?.matches.length ?? 0,
      truncated: false,
      cancelled: token.isCancellationRequested,
      phase: 'complete',
      backend: 'currentFile',
    };
  }

  public async scanUri(uri: vscode.Uri): Promise<boolean> {
    this.invalidateUri(uri);
    const scanRevision = ++this.revision;
    const settings = getTodoSettings();
    const workspace = vscode.workspace.getWorkspaceFolder(uri);
    const openDocument = this.isOpenTextDocumentUri(uri)
      ? vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
      : undefined;
    if (openDocument === undefined && workspace !== undefined && !(await this.isIncludedWorkspaceUri(uri, workspace))) {
      return this.index.removeAtRevision(uri.toString(), scanRevision);
    }
    const options = openDocument === undefined
      ? createTodoParseOptionsForPath(uri.path, settings)
      : createTodoParseOptions(openDocument.languageId, settings);
    if (!settings.enabled || options === undefined) return this.index.removeAtRevision(uri.toString(), scanRevision);
    try {
      const text = openDocument?.getText() ?? await this.readText(uri);
      if (text === undefined) return false;
      return this.index.replace(
        uri.toString(), parseTodoText(text, options), scanRevision,
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
    this.invalidatedFiles.clear();
    const scanRevision = ++this.revision;
    const settings = getTodoSettings();
    if (!settings.enabled) {
      if (!token.isCancellationRequested) this.index.reconcile({ entries: [], revisions: [] }, scanRevision);
      return {
        files: 0, candidateFiles: 0, discoveredFiles: 0, skippedFiles: 0, results: 0,
        truncated: false, cancelled: false, phase: 'complete', backend: 'vscode',
      };
    }
    if (!settings.showProjectMarkers && settings.ownerIdentities.length === 0) {
      if (!token.isCancellationRequested) this.index.reconcile({ entries: [], revisions: [] }, scanRevision);
      return {
        files: 0, candidateFiles: 0, discoveredFiles: 0, skippedFiles: 0, results: 0,
        truncated: false, cancelled: token.isCancellationRequested, phase: 'complete', backend: 'vscode',
      };
    }
    const seededUris = this.seedOpenDocuments(settings);
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
    const signature = todoCacheSignature();
    let inventory: TodoInventory | undefined;
    try {
      // 首轮仍使用 Git/rg 快速候选；先记文件状态，不能把扫描后的状态误配给扫描前的内容。
      if (this.storage) inventory = await collectTodoInventory(token, this.filesApi);
      discovery = await this.findCandidateUris(settings, token);
    } catch (error) {
      return this.failedScan(error, 'vscode');
    }
    const uris = discovery.uris;
    let lastProgressAt = 0;
    const openDocuments = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]));
    const staging = new TodoIndex();
    const diskFiles = new Map<string, TodoCachedFile>();
    for (const [uri, stamp] of inventory?.stamps ?? []) diskFiles.set(uri, { uri, ...stamp, matches: [] });
    let cacheComplete = inventory?.complete === true && discovery.discoveredFiles < MAX_DISCOVERED_FILES;
    // 清单中的超大文件也纳入提示，即使快速搜索没有命中它；不读取正文即可缓存其状态。
    const oversized = new Set<string>();
    let processedOversized = 0;
    for (const [key, stamp] of inventory?.stamps ?? []) {
      if (stamp.size > MAX_FILE_BYTES && !openDocuments.has(key)) {
        oversized.add(key);
        this.reportOversized(vscode.Uri.parse(key));
      }
    }

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
      files: Math.max(0, progress.files - processedOversized),
      candidateFiles: uris.length,
      discoveredFiles: discovery.discoveredFiles,
      skippedFiles: progress.skippedFiles + processedOversized,
      oversizedFiles: oversized.size,
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
          if (!openDocument) {
            const stamp = await this.filesApi.stat(uri);
            if (stamp.type === vscode.FileType.File && stamp.size > MAX_FILE_BYTES) {
              if (!oversized.has(uri.toString())) this.reportOversized(uri);
              oversized.add(uri.toString());
              processedOversized += 1;
              diskFiles.set(uri.toString(), { uri: uri.toString(), mtime: stamp.mtime,
                ctime: stamp.ctime, size: stamp.size, matches: [] });
              return [];
            }
            oversized.delete(uri.toString());
          }
          const text = openDocument?.getText() ?? await this.readText(uri);
          if (text === undefined) { cacheComplete = false; return undefined; }
          const matches = parseTodoText(text, options);
          const before = inventory?.stamps.get(uri.toString());
          if (before && !openDocument) {
            const after = await this.filesApi.stat(uri);
            if (sameTodoFileStamp(before, after)) diskFiles.set(uri.toString(), { uri: uri.toString(), ...before, matches });
            else cacheComplete = false;
          }
          return acceptMatches(matches);
        },
        commit: (uri, matches) => {
          const workspace = vscode.workspace.getWorkspaceFolder(uri);
          staging.replace(
            uri.toString(), matches, scanRevision,
            workspace === undefined ? uri.path.split('/').pop() ?? uri.toString() : vscode.workspace.asRelativePath(uri, false),
            workspace?.uri.toString(),
          );
        },
        onSkipped: (uri, error) => {
          cacheComplete = false;
          if (error === undefined) return;
          this.output.appendLine(`TODO 扫描跳过 ${uri.path.split('/').pop() ?? '未知文件'}：${error instanceof Error ? error.name : '读取失败'}`);
        },
        onProgress: (progress) => reportProgress(progress),
      });
    } catch (error) {
      return this.failedScan(error, discovery.backend, {
        files: 0,
        candidateFiles: uris.length,
        discoveredFiles: discovery.discoveredFiles,
        skippedFiles: 0,
      });
    }
    if (!scanProgress.cancelled && !token.isCancellationRequested) {
      // 不逐项覆盖正式索引：一次合并完整扫描，并由修订号保留扫描期间的实时修改和删除。
      // 这是防止“扫描中有标记，扫描完成后消失”的关键；取消的临时结果不能在这里提交。
      this.index.reconcile(staging.snapshot(), scanRevision);
      if (cacheComplete && !scanProgress.truncated && !personalTruncated && !projectTruncated) {
        const now = Date.now();
        await this.saveCache({ version: 1, signature, savedAt: now, fullAt: now, files: [...diskFiles.values()] }, token);
      }
    }
    reportProgress(scanProgress, true);
    return {
      ...summary(scanProgress, 'complete'),
      updateKind: 'full',
      results: this.countResults(),
      cancelled: scanProgress.cancelled || token.isCancellationRequested,
    };
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
          MAX_DISCOVERED_FILES,
          token,
        );
        if (discovered.length >= MAX_DISCOVERED_FILES) {
          this.output.appendLine(`TODO 兼容扫描已限制为前 ${MAX_DISCOVERED_FILES} 个文件，请安装 Git 或 ripgrep 以使用快速搜索。`);
        }
        const supported = discovered.filter((uri) => createTodoParseOptionsForPath(uri.path, settings) !== undefined);
        return { uris: supported, discoveredFiles: supported.length, backend: 'vscode' as const };
      }
      const selected = new Map<string, vscode.Uri>();
      const addCandidate = (relativePath: string): void => {
        const normalized = normalizeTodoCandidatePath(relativePath);
        if (normalized === undefined) return;
        const uri = vscode.Uri.joinPath(folder.uri, ...normalized.split('/'));
        if (selected.size >= MAX_DISCOVERED_FILES && !selected.has(uri.toString())) return;
        if (createTodoParseOptionsForPath(uri.path, settings) !== undefined) selected.set(uri.toString(), uri);
      };
      for (const path of personalResult?.relativePaths ?? []) addCandidate(path);
      for (const path of fastResult.relativePaths) addCandidate(path);
      if ((personalResult?.relativePaths.length ?? 0) + fastResult.relativePaths.length > MAX_DISCOVERED_FILES) {
        this.output.appendLine(`TODO 快速搜索候选已限制为前 ${MAX_DISCOVERED_FILES} 个文件。`);
      }
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

  private seedOpenDocuments(settings: ReturnType<typeof getTodoSettings>): vscode.Uri[] {
    const uris: vscode.Uri[] = [];
    for (const document of vscode.workspace.textDocuments) {
      if (!this.isOpenTextDocumentUri(document.uri)) continue;
      const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
      const options = createTodoParseOptions(document.languageId, settings);
      if (workspace === undefined || options === undefined) continue;
      this.replaceDocument(document, settings, ++this.revision);
      uris.push(document.uri);
    }
    return uris;
  }

  private isOpenTextDocumentUri(uri: vscode.Uri): boolean {
    const key = uri.toString();
    return vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => {
      const input = tab.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === key;
    }));
  }

  private countResults(): number {
    return this.index.values().reduce((sum, entry) => sum + entry.matches.length, 0);
  }

  private failedScan(
    error: unknown,
    backend: TodoScanBackend,
    progress: Pick<TodoScanSummary, 'files' | 'candidateFiles' | 'discoveredFiles' | 'skippedFiles'> = {
      files: 0,
      candidateFiles: 0,
      discoveredFiles: 0,
      skippedFiles: 0,
    },
  ): TodoScanSummary {
    const results = this.countResults();
    return {
      ...progress,
      results,
      truncated: false,
      cancelled: false,
      phase: 'failed',
      backend,
      error: error instanceof Error ? error.name : '未知错误',
      stale: results > 0,
    };
  }

  private reportOversized(uri: vscode.Uri): void {
    this.output.appendLine(`TODO 已跳过超过 2 MiB 的文件：${vscode.workspace.asRelativePath(uri, true)}`);
  }

  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    const stat = await this.filesApi.stat(uri);
    if (stat.type !== vscode.FileType.File || stat.size > MAX_FILE_BYTES) return undefined;
    const bytes = await this.filesApi.readFile(uri);
    const configuredEncoding = vscode.workspace.getConfiguration('files', uri).get<string>('encoding', 'utf8');
    const decoded = decodeTodoText(bytes, configuredEncoding, vscode.env.language);
    if (decoded === undefined) return undefined;
    if (decoded.fallback) {
      const workspace = vscode.workspace.getWorkspaceFolder(uri);
      const resource = workspace === undefined
        ? uri.path.split('/').pop() ?? uri.toString()
        : vscode.workspace.asRelativePath(uri, false);
      this.output.appendLine(`TODO 使用 ${decoded.encoding} 兼容读取 ${resource}。`);
    }
    return decoded.text;
  }
}

/**
 * r10 编码修复：未打开文件不能假定为 UTF-8，否则含中文注释的旧编码源码可能被跳过。
 * 依次尝试 BOM、配置编码、UTF-8、界面语言对应编码，最后以容错 UTF-8 读取。
 * 语言对应编码仅是兜底推测，不是准确检测；容错读取可能影响文字和列位置。
 * 这里只负责已发现候选文件的解码，不能保证搜索后端会发现所有编码的文件。
 */
function decodeTodoText(
  bytes: Uint8Array,
  configuredEncoding: string,
  locale: string,
): TodoTextDecodeResult | undefined {
  const bom = detectBom(bytes);
  if (bom !== undefined) {
    const text = decodeStrict(bytes.subarray(bom.offset), bom.encoding);
    return text === undefined ? undefined : { text, encoding: bom.encoding, fallback: false };
  }
  if (bytes.includes(0)) return undefined;

  const configured = normalizeEncodingLabel(configuredEncoding) ?? 'utf-8';
  const configuredText = decodeStrict(bytes, configured);
  if (configuredText !== undefined) {
    return { text: configuredText, encoding: configured, fallback: false };
  }

  const utf8Text = configured === 'utf-8' ? undefined : decodeStrict(bytes, 'utf-8');
  if (utf8Text !== undefined) {
    return { text: utf8Text, encoding: 'utf-8', fallback: true };
  }

  const localeEncoding = encodingForLocale(locale);
  if (localeEncoding !== undefined && localeEncoding !== configured) {
    const localeText = decodeStrict(bytes, localeEncoding);
    if (localeText !== undefined) {
      return { text: localeText, encoding: localeEncoding, fallback: true };
    }
  }

  return {
    text: new TextDecoder('utf-8').decode(bytes),
    encoding: 'UTF-8 容错模式',
    fallback: true,
  };
}

function detectBom(bytes: Uint8Array): { readonly encoding: string; readonly offset: number } | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', offset: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', offset: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', offset: 2 };
  }
  return undefined;
}

function decodeStrict(bytes: Uint8Array, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function normalizeEncodingLabel(value: string): string | undefined {
  const key = value.trim().toLocaleLowerCase().replaceAll('-', '').replaceAll('_', '');
  const labels: Readonly<Record<string, string>> = {
    utf8: 'utf-8',
    utf8bom: 'utf-8',
    utf16le: 'utf-16le',
    utf16be: 'utf-16be',
    windows1252: 'windows-1252',
    iso88591: 'windows-1252',
    windows1251: 'windows-1251',
    cp866: 'ibm866',
    koi8r: 'koi8-r',
    gbk: 'gbk',
    gb2312: 'gbk',
    gb18030: 'gb18030',
    cp950: 'big5',
    big5: 'big5',
    shiftjis: 'shift_jis',
    sjis: 'shift_jis',
    eucjp: 'euc-jp',
    euckr: 'euc-kr',
  };
  return labels[key];
}

function encodingForLocale(locale: string): string | undefined {
  const normalized = locale.trim().toLocaleLowerCase();
  if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk') || normalized.startsWith('zh-mo')) return 'big5';
  if (normalized.startsWith('zh')) return 'gb18030';
  if (normalized.startsWith('ja')) return 'shift_jis';
  if (normalized.startsWith('ko')) return 'euc-kr';
  if (normalized.startsWith('ru')) return 'windows-1251';
  return undefined;
}
