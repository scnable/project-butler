import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ActiveExclusion, ExclusionServiceV2 } from '../exclusions/exclusionServiceV2';
import { consolidateHierarchicalResources, isDescendantPattern } from '../exclusions/exclusionHierarchy';
import {
  buildExclusionPatterns,
  buildFileTypeExclusionPattern,
  escapeGlobPath,
  normalizeRelativePath,
} from '../exclusions/exclusionPatterns';
import { currentWorkspaceUri, getApi, projectUri } from './helpers';

suite('屏蔽与取消屏蔽', () => {
  test('INT-103 现有单文件规则可由三类工作区设置统一识别', async () => {
    const api = await getApi();
    const active = api.exclusions.listActiveExclusions();
    const txt = active.find((item) => item.pattern === '**/*.txt');
    assert.ok(txt);
    assert.deepEqual([...txt.targets].sort(), ['目录展示', '搜索', '文件监控'].sort());
  });

  test('INT-104 目录生成三类正确递归规则', () => {
    const patterns = buildExclusionPatterns('generated', 'directory');
    assert.equal(patterns.explorer, 'generated');
    assert.equal(patterns.search, 'generated/**');
    assert.equal(patterns.watcher, 'generated/**');
  });

  test('INT-105 多选资源可以汇总且不重复', () => {
    const result = consolidateHierarchicalResources([
      { relativePath: 'a.txt', kind: 'file', value: 'a1' },
      { relativePath: 'a.txt', kind: 'file', value: 'a2' },
      { relativePath: 'b.txt', kind: 'file', value: 'b' },
    ]);
    assert.deepEqual(result.map((item) => item.relativePath), ['a.txt', 'b.txt']);
  });

  test('INT-106 同时选择父目录和子项只保留父目录', () => {
    const result = consolidateHierarchicalResources([
      { relativePath: 'src', kind: 'directory', value: 'parent' },
      { relativePath: 'src/app.ts', kind: 'file', value: 'child' },
    ]);
    assert.deepEqual(result.map((item) => item.value), ['parent']);
  });

  test('INT-107 父目录规则能识别已覆盖的子规则', () => {
    assert.equal(isDescendantPattern('src/generated/file.ts', 'src/**'), true);
    assert.equal(isDescendantPattern('src/generated/**', 'src/**'), true);
  });

  test('INT-108 相似名称但非层级关系不会误合并', () => {
    const result = consolidateHierarchicalResources([
      { relativePath: 'a', kind: 'directory', value: 'a' },
      { relativePath: 'ab', kind: 'directory', value: 'ab' },
    ]);
    assert.equal(result.length, 2);
  });

  test('INT-109 Glob 特殊字符路径被正确转义', () => {
    assert.equal(escapeGlobPath('src/[demo]/{x}.ts'), 'src/[[]demo[]]/[{]x[}].ts');
  });

  test('INT-110 中文和空格路径保持可读', () => {
    const normalized = normalizeRelativePath('中文 空格目录\\说明 文件.txt');
    assert.equal(normalized, '中文 空格目录/说明 文件.txt');
  });

  test('INT-111 工作区资源能够解析到所属根目录', async () => {
    const api = await getApi();
    const uri = projectUri(api, 'test-fixtures/workspace-one/src/app.ts');
    assert.equal(vscode.workspace.getWorkspaceFolder(uri)?.uri.toString(), vscode.workspace.workspaceFolders?.[0]?.uri.toString());
  });

  test('INT-112 确认取消前不调用写入服务时设置保持不变', () => {
    const before = vscode.workspace.getConfiguration('files').inspect<Record<string, boolean>>('exclude')?.workspaceValue;
    const after = vscode.workspace.getConfiguration('files').inspect<Record<string, boolean>>('exclude')?.workspaceValue;
    assert.deepEqual(after, before);
  });

  test('INT-113 屏蔽前确认关闭值能够被真实配置读取', () => {
    const value = vscode.workspace.getConfiguration('projectManager.exclusions').get<boolean>('confirmBeforeApply', true);
    assert.equal(typeof value, 'boolean');
  });

  test('INT-114 同类型文件生成全工作区扩展名规则', () => {
    assert.equal(buildFileTypeExclusionPattern('.log'), '**/*.log');
    assert.equal(buildFileTypeExclusionPattern('.gz'), '**/*.gz');
  });

  test('INT-115 无扩展名资源不会生成同类型规则', async () => {
    const api = await getApi();
    const result = await api.exclusions.excludeFileTypes([
      projectUri(api, 'test-fixtures/workspace-one/README'),
    ]);
    assert.equal(result.typeCount, 0);
    assert.equal(result.skippedCount, 1);
  });

  test('INT-116 只恢复选中规则并保留未选规则', async () => {
    const api = await getApi();
    const explorer = createMemoryConfiguration({ 'target.txt': true, 'keep.txt': true });
    const search = createMemoryConfiguration({ 'target.txt': true, 'keep.txt': true });
    const watcher = createMemoryConfiguration({ 'target.txt': true, 'keep.txt': true });
    const service = new ExclusionServiceV2(api.output, api.context.workspaceState, (section) => {
      if (section === 'search') return search.configuration;
      return memoryConfigurationCallCount++ % 2 === 0 ? explorer.configuration : watcher.configuration;
    });
    memoryConfigurationCallCount = 0;
    const selected: ActiveExclusion = {
      id: 'memory::target.txt',
      folderUri: currentWorkspaceUri().toString(),
      folderName: 'workspace-one',
      pattern: 'target.txt',
      recursive: false,
      targets: ['目录展示', '搜索', '文件监控'],
    };
    const result = await service.restore([selected]);
    assert.deepEqual(result, { restoredCount: 1, restoredCoveredRuleCount: 0 });
    for (const state of [explorer.value(), search.value(), watcher.value()]) {
      assert.equal(Object.hasOwn(state, 'target.txt'), false);
      assert.equal(state['keep.txt'], true);
    }
  });
});

let memoryConfigurationCallCount = 0;

function createMemoryConfiguration(initial: Record<string, boolean>): {
  readonly configuration: vscode.WorkspaceConfiguration;
  readonly value: () => Record<string, boolean>;
} {
  let current = { ...initial };
  const configuration = {
    inspect: () => ({ workspaceFolderValue: current }),
    update: async (_key: string, value: Record<string, boolean>) => {
      current = { ...value };
    },
  } as unknown as vscode.WorkspaceConfiguration;
  return { configuration, value: () => current };
}
