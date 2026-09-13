import * as assert from 'node:assert/strict';
import childProcess = require('node:child_process');
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { LocalTodoCandidateSearch } from '../todo/todoLocalSearch';
import { TodoScanSummary } from '../todo/todoScanner';
import { getApi, setWorkspaceSetting } from './helpers';

suite('TODO OOM 回归', () => {
  const sandbox = sinon.createSandbox();

  teardown(() => {
    sandbox.restore();
  });

  test('OOM-001 连续完整更新不得并发保留已取消扫描', async () => {
    const api = await getApi();
    await api.todo.waitForIdleForIntegrationTest();
    api.todo.provider.scope = 'workspace';

    let activeScans = 0;
    let maximumActiveScans = 0;
    let startedScans = 0;
    const releases = new Set<() => void>();

    sandbox.stub(api.todo.scanner, 'scanWorkspace').callsFake(async (token) => {
      startedScans += 1;
      activeScans += 1;
      maximumActiveScans = Math.max(maximumActiveScans, activeScans);

      try {
        await new Promise<void>((resolve) => {
          let settled = false;
          const release = (): void => {
            if (settled) return;
            settled = true;
            releases.delete(release);
            resolve();
          };
          releases.add(release);
          const cancellation = token.onCancellationRequested(() => {
            // 模拟 Win10 上 git/rg 收到终止请求后仍需一段时间才真正退出。
            setTimeout(() => {
              cancellation.dispose();
              release();
            }, 80);
          });
          setTimeout(() => {
            cancellation.dispose();
            release();
          }, 500);
        });
      } finally {
        activeScans -= 1;
      }

      return completedSummary(token.isCancellationRequested);
    });

    const first = api.todo.refresh();
    await waitUntil(() => startedScans >= 1);
    const second = api.todo.refresh(false);
    const third = api.todo.refresh();

    for (const release of [...releases]) release();
    await Promise.all([first, second, third]);

    assert.equal(
      maximumActiveScans,
      1,
      `完整更新发生重入，最大并发扫描数为 ${maximumActiveScans}`,
    );
  });

  test('OOM-002 搜索取消后必须解绑子进程输出监听', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, '当前测试需要工作区');

    const stdout = new PassThrough();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      kill: () => boolean;
    };
    child.stdout = stdout;
    const kill = sandbox.spy(() => true);
    child.kill = kill;
    sandbox.stub(childProcess, 'spawn').returns(child as never);

    const cancellation = new vscode.CancellationTokenSource();
    const search = new LocalTodoCandidateSearch().search(
      folder,
      { mode: 'fixed', patterns: ['TODO'] },
      [],
      cancellation.token,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    stdout.write(Buffer.alloc(1_024));
    cancellation.cancel();
    await search;

    assert.equal(kill.callCount, 1);
    assert.equal(
      stdout.listenerCount('data'),
      0,
      '搜索 Promise 已结束，但 stdout data 监听仍然保留并可继续缓存输出',
    );
    cancellation.dispose();
    stdout.destroy();
  });

  test('OOM-003 仅修改高亮配置不得触发完整更新', async () => {
    const api = await getApi();
    await api.todo.waitForIdleForIntegrationTest();
    api.todo.provider.scope = 'workspace';
    const configuration = vscode.workspace.getConfiguration('projectManager.todo');
    const original = configuration.inspect<boolean>('highlight')?.workspaceValue;
    const effective = configuration.get<boolean>('highlight', true);
    const scan = sandbox.stub(api.todo.scanner, 'scanWorkspace').resolves(completedSummary(false));

    try {
      await setWorkspaceSetting('projectManager.todo', 'highlight', !effective);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(scan.callCount, 0, '仅修改高亮配置却触发了完整更新');
    } finally {
      await setWorkspaceSetting('projectManager.todo', 'highlight', original);
    }
  });
});

function completedSummary(cancelled: boolean): TodoScanSummary {
  return {
    files: 0,
    candidateFiles: 0,
    discoveredFiles: 0,
    skippedFiles: 0,
    results: 0,
    truncated: false,
    cancelled,
    phase: 'complete',
    backend: 'vscode',
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待扫描启动超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
