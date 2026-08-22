import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { TODO_SEARCH_GLOBS } from './todoCommentSyntax';
import { parseTodoCandidatePathOutput } from './todoScanPlan';
import { TodoCandidateSearch, TodoCandidateSearchResult } from './todoSearchBackend';

const MAX_PATH_OUTPUT_BYTES = 16 * 1024 * 1024;

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: Buffer;
}

export class LocalTodoCandidateSearch implements TodoCandidateSearch {
  public async search(
    folder: vscode.WorkspaceFolder,
    terms: readonly string[],
    excludePatterns: readonly string[],
    token: vscode.CancellationToken,
  ): Promise<TodoCandidateSearchResult | undefined> {
    if (folder.uri.scheme !== 'file' || terms.length === 0 || token.isCancellationRequested) return undefined;
    const git = await this.tryGit(folder.uri.fsPath, terms, token);
    if (git !== undefined || token.isCancellationRequested) return git;
    return this.tryRipgrep(folder.uri.fsPath, terms, excludePatterns, token);
  }

  private async tryGit(cwd: string, terms: readonly string[], token: vscode.CancellationToken): Promise<TodoCandidateSearchResult | undefined> {
    const grepArgs = ['grep', '-l', '-z', '-I', '-i', '-F'];
    for (const term of terms) grepArgs.push('-e', term);
    grepArgs.push('--', '.');
    try {
      const grep = await runProcess('git', grepArgs, cwd, token);
      if (grep.code !== 0 && grep.code !== 1) return undefined;
      const untracked = await runProcess('git', ['ls-files', '-z', '--others', '--exclude-standard', '--', '.'], cwd, token);
      if (untracked.code !== 0) return undefined;
      return {
        backend: 'git',
        relativePaths: parseTodoCandidatePathOutput(Buffer.concat([grep.stdout, untracked.stdout])),
      };
    } catch {
      return undefined;
    }
  }

  private async tryRipgrep(
    cwd: string,
    terms: readonly string[],
    excludePatterns: readonly string[],
    token: vscode.CancellationToken,
  ): Promise<TodoCandidateSearchResult | undefined> {
    const args = ['--files-with-matches', '--null', '--ignore-case', '--fixed-strings', '--hidden', '--no-ignore', '--no-messages'];
    for (const term of terms) args.push('--regexp', term);
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
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cancellation?.dispose();
      reject(error);
    };
    cancellation = token.onCancellationRequested(() => {
      child.kill();
      finishReject(new vscode.CancellationError());
    });
    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_PATH_OUTPUT_BYTES) {
        child.kill();
        finishReject(new Error('候选路径输出超过安全上限'));
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', finishReject);
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cancellation?.dispose();
      resolve({ code, stdout: Buffer.concat(chunks) });
    });
  });
}
