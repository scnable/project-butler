/**
 * 通过本地 Git / ripgrep 搜索可能含标记的文件，再交给扫描器读取并精确解析。
 * 成功但没有匹配与后端不可用是两种结果，不能混为一谈，否则会无谓触发更慢的兜底搜索。
 * 历史内存问题要求取消时释放输出监听和缓存、终止子进程，并限制输出大小；不要累积多轮搜索输出。
 */
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { TODO_SEARCH_GLOBS } from './todoCommentSyntax';
import { parseTodoCandidatePathOutput, TodoSearchQuery } from './todoScanPlan';
import { TodoCandidateSearch, TodoCandidateSearchResult } from './todoSearchBackend';

const MAX_PATH_OUTPUT_BYTES = 16 * 1024 * 1024;

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: Buffer;
}

export class LocalTodoCandidateSearch implements TodoCandidateSearch {
  public async search(
    folder: vscode.WorkspaceFolder,
    query: TodoSearchQuery,
    excludePatterns: readonly string[],
    token: vscode.CancellationToken,
  ): Promise<TodoCandidateSearchResult | undefined> {
    if (folder.uri.scheme !== 'file' || query.patterns.length === 0 || token.isCancellationRequested) return undefined;
    const git = await this.tryGit(folder.uri.fsPath, query, excludePatterns, token);
    if (git !== undefined || token.isCancellationRequested) return git;
    return this.tryRipgrep(folder.uri.fsPath, query, excludePatterns, token);
  }

  private async tryGit(
    cwd: string,
    query: TodoSearchQuery,
    excludePatterns: readonly string[],
    token: vscode.CancellationToken,
  ): Promise<TodoCandidateSearchResult | undefined> {
    const grepArgs = ['grep', '--untracked', '-l', '-z', '-I', '-i', query.mode === 'fixed' ? '-F' : '-E'];
    for (const pattern of query.patterns) grepArgs.push('-e', pattern);
    grepArgs.push('--', '.');
    for (const pattern of excludePatterns) grepArgs.push(`:(exclude,glob)${pattern}`);
    try {
      const grep = await runProcess('git', grepArgs, cwd, token);
      if (grep.code !== 0 && grep.code !== 1) return undefined;
      return {
        backend: 'git',
        relativePaths: parseTodoCandidatePathOutput(grep.stdout),
      };
    } catch {
      return undefined;
    }
  }

  private async tryRipgrep(
    cwd: string,
    query: TodoSearchQuery,
    excludePatterns: readonly string[],
    token: vscode.CancellationToken,
  ): Promise<TodoCandidateSearchResult | undefined> {
    const args = ['--files-with-matches', '--null', '--ignore-case', '--hidden', '--no-ignore', '--no-messages'];
    if (query.mode === 'fixed') args.push('--fixed-strings');
    for (const pattern of query.patterns) args.push('--regexp', pattern);
    for (const glob of TODO_SEARCH_GLOBS) args.push('--glob', glob);
    for (const pattern of excludePatterns) args.push('--glob', `!${pattern}`);
    args.push('.');
    try {
      const result = await runProcess('rg', args, cwd, token);
      if (result.code !== 0 && result.code !== 1) return undefined;
      return { backend: 'ripgrep', relativePaths: parseTodoCandidatePathOutput(result.stdout) };
    } catch {
      return undefined;
    }
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  token: vscode.CancellationToken,
): Promise<ProcessResult> {
  if (token.isCancellationRequested) throw new vscode.CancellationError();
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let cancellation: vscode.Disposable | undefined;
    const cleanup = (): void => {
      cancellation?.dispose();
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const finishReject = (error: Error, terminate = false): void => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      if (terminate) {
        child.stdout.destroy();
        child.kill();
      }
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_PATH_OUTPUT_BYTES) {
        finishReject(new Error('候选路径输出超过安全上限'), true);
        return;
      }
      chunks.push(chunk);
    };
    const onError = (error: Error): void => finishReject(error);
    const onClose = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdout = Buffer.concat(chunks);
      chunks.length = 0;
      resolve({ code, stdout });
    };
    cancellation = token.onCancellationRequested(() => {
      finishReject(new vscode.CancellationError(), true);
    });
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}
