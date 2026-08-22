import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { getTodoCommentSyntax, getTodoInsertionToken, inferTodoLanguageId } from '../todo/todoCommentSyntax';
import { TodoIndex } from '../todo/todoIndex';
import { findMarker } from '../todo/todoMarkerModel';
import { isMyTodoOwner, normalizeTodoOwner, normalizeTodoOwners } from '../todo/todoOwner';
import { parseTodoText } from '../todo/todoParser';
import {
  collectTodoExcludePatterns, createTodoExcludeGlob, createTodoSearchTerms,
  DEFAULT_TODO_EXCLUDE_PATTERNS, normalizeTodoCandidatePath, parseTodoCandidatePathOutput,
} from '../todo/todoScanPlan';
import { combineTodoScanBackends, todoScanBackendLabel } from '../todo/todoSearchBackend';
import { runTodoScanEngine } from '../todo/todoScanEngine';
import {
  createTodoTagDefinitions,
  DEFAULT_TODO_TAG_NAMES,
  getAllTodoTagChoices,
  normalizeTodoTagName,
  normalizeTodoTagNames,
} from '../todo/todoTags';
import { TodoViewRefreshPolicy } from '../todo/todoViewRefreshPolicy';
import { buildTodoHierarchy } from '../todo/todoTreeModel';
import { TodoMatch } from '../todo/todoTypes';

const SAMPLE_MATCH: TodoMatch = {
  tag: 'TODO', rawTag: 'TODO', text: 'sample', line: 0,
  startCharacter: 3, endCharacter: 7, completed: false, source: 'comment',
};

describe('代码 TODO 关键词', () => {
  it('提供五个默认标签并规范化自定义关键词', () => {
    assert.deepEqual(normalizeTodoTagNames(undefined), [...DEFAULT_TODO_TAG_NAMES]);
    assert.equal(normalizeTodoTagName(' debug '), 'DEBUG');
    assert.equal(normalizeTodoTagName('bad tag'), undefined);
    assert.equal(normalizeTodoTagName('A'.repeat(33)), undefined);
  });

  it('不区分大小写去重且空配置回退默认标签', () => {
    assert.deepEqual(normalizeTodoTagNames(['todo', 'TODO', 'review']), ['TODO', 'REVIEW']);
    assert.deepEqual(normalizeTodoTagNames([]), [...DEFAULT_TODO_TAG_NAMES]);
  });

  it('DEBUG 等预置关键词默认关闭但可以启用', () => {
    const choices = getAllTodoTagChoices(['TODO', 'DEBUG']);
    assert.equal(choices.find((choice) => choice.name === 'DEBUG')?.enabled, true);
    assert.equal(choices.find((choice) => choice.name === 'NOTE')?.enabled, false);
  });
});

describe('代码 TODO 注释解析', () => {
  const tags = createTodoTagDefinitions(['TODO', 'FIXME', 'DEBUG']);
  const cSyntax = getTodoCommentSyntax('c')!;

  it('识别行注释、行尾注释和块注释', () => {
    const results = parseTodoText([
      '// TODO: first',
      'call(); // FIXME second',
      '/* DEBUG: inspect */',
      '/*',
      ' * TODO: block',
      ' */',
    ].join('\n'), { tags, markdownTasks: false, lineCommentTokens: cSyntax.lineTokens, blockCommentTokens: cSyntax.blockTokens });
    assert.deepEqual(results.map((result) => [result.tag, result.text, result.line]), [
      ['TODO', 'first', 0], ['FIXME', 'second', 1], ['DEBUG', 'inspect', 2], ['TODO', 'block', 4],
    ]);
  });

  it('不匹配字符串、标识符、普通正文和已完成标记', () => {
    const results = parseTodoText([
      'const char *value = "// TODO: text";',
      '// TODO_COUNT: 1',
      '// explain DEBUG mode',
      '// DEBUG_MODE: active',
      '// TODO [x]: done',
    ].join('\n'), { tags, markdownTasks: false, lineCommentTokens: cSyntax.lineTokens, blockCommentTokens: cSyntax.blockTokens });
    assert.deepEqual(results, []);
  });

  it('DEBUG 不误匹配条件编译但识别井号注释标记', () => {
    const syntax = getTodoCommentSyntax('python')!;
    const results = parseTodoText('#ifdef DEBUG\n# DEBUG: inspect\nDEBUG_MODE = true', {
      tags, markdownTasks: false, lineCommentTokens: syntax.lineTokens, blockCommentTokens: syntax.blockTokens,
    });
    assert.deepEqual(results.map((result) => [result.tag, result.text, result.line]), [['DEBUG', 'inspect', 1]]);
  });

  it('识别负责人语法并保留普通未分配标记', () => {
    const results = parseTodoText('// TODO(scnable): mine\n// FIXME: shared', {
      tags, markdownTasks: false, lineCommentTokens: cSyntax.lineTokens, blockCommentTokens: cSyntax.blockTokens,
    });
    assert.deepEqual(results.map((result) => [result.tag, result.owner, result.text]), [
      ['TODO', 'scnable', 'mine'], ['FIXME', undefined, 'shared'],
    ]);
  });

  it('识别 Markdown 未完成项并排除已完成项', () => {
    const results = parseTodoText('- [ ] first\n* [x] done', {
      tags, markdownTasks: true, lineCommentTokens: [], blockCommentTokens: [],
    });
    assert.deepEqual(results.map((result) => [result.source, result.text]), [['markdownTask', 'first']]);
  });

  it('TODO 关键词停用后不生成 Markdown TODO 结果', () => {
    const results = parseTodoText('- [ ] first', {
      tags: createTodoTagDefinitions(['DEBUG']), markdownTasks: true, lineCommentTokens: [], blockCommentTokens: [],
    });
    assert.deepEqual(results, []);
  });
});

describe('代码 TODO 注释语法与索引', () => {
  it('按语言和扩展名选择注释语法', () => {
    assert.deepEqual(getTodoInsertionToken('typescript'), { open: '//', close: '' });
    assert.deepEqual(getTodoInsertionToken('html'), { open: '<!--', close: '-->' });
    assert.equal(getTodoInsertionToken('unknown'), undefined);
    assert.equal(inferTodoLanguageId('src/main.CPP'), 'cpp');
    assert.equal(inferTodoLanguageId('Dockerfile'), 'dockerfile');
  });

  it('索引拒绝旧修订覆盖并保持路径排序', () => {
    const index = new TodoIndex();
    assert.equal(index.replace('b', [SAMPLE_MATCH], 2, 'src/b.ts'), true);
    assert.equal(index.replace('b', [SAMPLE_MATCH], 1, 'src/b.ts'), false);
    assert.equal(index.replace('a', [SAMPLE_MATCH], 1, 'src/a.ts'), true);
    assert.deepEqual(index.values().map((entry) => entry.uri), ['a', 'b']);
    assert.equal(index.remove('a'), true);
  });

  it('零结果不进入绘制索引且修订墓碑阻止旧结果回写', () => {
    const index = new TodoIndex();
    assert.equal(index.replace('a', [SAMPLE_MATCH], 2, 'src/a.ts'), true);
    assert.equal(index.replace('a', [], 3, 'src/a.ts'), true);
    assert.equal(index.size, 0);
    assert.equal(index.replace('a', [SAMPLE_MATCH], 2, 'src/a.ts'), false);
    assert.equal(index.get('a'), undefined);
  });

  it('索引快照可恢复结果和修订边界', () => {
    const index = new TodoIndex();
    index.replace('a', [SAMPLE_MATCH], 4, 'src/a.ts');
    index.replace('removed', [], 6, 'src/removed.ts');
    const snapshot = index.snapshot();
    index.clear();
    index.replace('temporary', [SAMPLE_MATCH], 10, 'src/temporary.ts');

    index.restore(snapshot);

    assert.deepEqual(index.values().map((entry) => entry.uri), ['a']);
    assert.equal(index.get('temporary'), undefined);
    assert.equal(index.replace('removed', [SAMPLE_MATCH], 5, 'src/removed.ts'), false);
  });
});

describe('代码 TODO 快速标记定位', () => {
  it('定位当前标记、完成状态和安全删除边界', () => {
    const marker = findMarker('  // TODO [x]: keep this text', ['TODO', 'FIXME']);
    assert.ok(marker);
    assert.equal(marker.tag, 'TODO');
    assert.equal('  // TODO [x]: keep this text'.slice(marker.tagStart, marker.tagEnd), 'TODO');
    assert.equal('  // TODO [x]: keep this text'.slice(marker.syntaxEnd), 'keep this text');
    assert.deepEqual(marker.completedRange, { start: 9, end: 13 });
  });

  it('不把普通代码或未启用关键词当作当前标记', () => {
    assert.equal(findMarker('const TODO = 1;', ['TODO']), undefined);
    assert.equal(findMarker('// DEBUG: inspect', ['TODO']), undefined);
  });

  it('定位负责人及完成状态且保留安全编辑边界', () => {
    const line = '// TODO(scnable) [x]: keep';
    const marker = findMarker(line, ['TODO']);
    assert.ok(marker);
    assert.equal(marker.owner, 'scnable');
    assert.equal(line.slice(marker.ownerRange?.start, marker.ownerRange?.end), 'scnable');
    assert.equal(line.slice(marker.ownerSyntaxRange?.start, marker.ownerSyntaxRange?.end), '(scnable)');
    assert.equal(marker.qualifierEnd, line.indexOf(' [x]'));
    assert.equal(line.slice(marker.syntaxEnd), 'keep');
  });
});

describe('代码 TODO 个人标识与目录模型', () => {
  it('规范化个人标识、历史别名并按大小写无关方式判断归属', () => {
    assert.equal(normalizeTodoOwner(' scnable '), 'scnable');
    assert.equal(normalizeTodoOwner('bad owner'), undefined);
    assert.deepEqual(normalizeTodoOwners('scnable', ['OLD', 'old', 'bad owner']), ['scnable', 'OLD']);
    assert.equal(isMyTodoOwner('ScNaBlE', ['scnable', 'OLD']), true);
    assert.equal(isMyTodoOwner(undefined, ['scnable']), false);
  });

  it('提取公共根并压缩连续的单子目录链', () => {
    const hierarchy = buildTodoHierarchy([
      { relativePath: 'src/pages/user/profile/settings/AccountSettings.ts' },
      { relativePath: 'src/pages/user/profile/settings/NotificationSettings.ts' },
      { relativePath: 'src/pages/admin/dashboard/Overview.ts' },
    ]);
    assert.equal(hierarchy.directories[0]?.label, 'src/pages/');
    const children = buildTodoHierarchy(hierarchy.directories[0]!.resources, hierarchy.directories[0]!.path);
    assert.deepEqual(children.directories.map((directory) => directory.label), [
      'admin/dashboard/', 'user/profile/settings/',
    ]);
  });
});

describe('代码 TODO 扫描计划', () => {
  it('合并默认目录、files.exclude、search.exclude 和插件写入的规则', () => {
    const patterns = collectTodoExcludePatterns(
      { documentation: true, '**/*.log': false },
      { examples: true, generated: true },
    );
    for (const pattern of DEFAULT_TODO_EXCLUDE_PATTERNS) assert.ok(patterns.includes(pattern));
    assert.ok(patterns.includes('documentation'));
    assert.ok(patterns.includes('documentation/**'));
    assert.ok(patterns.includes('examples/**'));
    assert.ok(patterns.includes('generated/**'));
    assert.equal(patterns.includes('**/*.log'), false);
  });

  it('条件式 files.exclude 不被错误扩展为无条件排除', () => {
    const patterns = collectTodoExcludePatterns({ '**/*.js': { when: '$(basename).ts' }, '**/*.map': true });
    assert.equal(patterns.includes('**/*.js'), false);
    assert.ok(patterns.includes('**/*.map'));
  });

  it('生成可直接交给 VS Code findFiles 的单一排除 Glob', () => {
    const glob = createTodoExcludeGlob({ documentation: true }, { examples: true });
    assert.match(glob, /^\{.*\}$/);
    assert.match(glob, /documentation\/\*\*/);
    assert.match(glob, /examples\/\*\*/);
  });

  it('生成固定字符串搜索词并规范化候选相对路径', () => {
    assert.deepEqual(createTodoSearchTerms(['TODO', 'DEBUG'], true), ['TODO', 'DEBUG', '[ ]']);
    assert.equal(normalizeTodoCandidatePath('.\\src\\main.c'), 'src/main.c');
    assert.equal(normalizeTodoCandidatePath('../outside.c'), undefined);
    assert.equal(normalizeTodoCandidatePath('C:\\outside.c'), undefined);
  });

  it('解析 Git 和 ripgrep 的 NUL 分隔路径并安全去重', () => {
    assert.deepEqual(parseTodoCandidatePathOutput(Buffer.from('src/a.c\0src\\b.c\0src/a.c\0../outside.c\0')), ['src/a.c', 'src/b.c']);
  });
});

describe('代码 TODO 快速扫描视图策略', () => {
  it('大量扫描进度不触发树刷新，仅首屏和完成各刷新一次', () => {
    const policy = new TodoViewRefreshPolicy();
    assert.equal(policy.shouldRefreshTree('start'), true);
    assert.equal(policy.shouldRefreshTree('openFiles'), true);
    assert.equal(policy.shouldRefreshTree('openFiles'), false);
    for (let index = 0; index < 10_000; index += 1) assert.equal(policy.shouldRefreshTree('progress'), false);
    assert.equal(policy.shouldRefreshTree('incremental'), false);
    assert.equal(policy.shouldRefreshTree('complete'), true);
    assert.equal(policy.shouldRefreshTree('incremental'), true);
  });

  it('组合后端状态并提供稳定中文标签', () => {
    assert.equal(combineTodoScanBackends(['git', 'git']), 'git');
    assert.equal(combineTodoScanBackends(['git', 'vscode']), 'mixed');
    assert.equal(todoScanBackendLabel('ripgrep'), 'ripgrep 快速搜索');
    assert.equal(todoScanBackendLabel(undefined), '兼容扫描');
  });

  it('并发扫描引擎限制并发并在结果上限处停止提交', async () => {
    let active = 0;
    let peakActive = 0;
    const committed: number[] = [];
    const summary = await runTodoScanEngine({
      items: [1, 2, 3, 4, 5, 6],
      concurrency: 2,
      maxResults: 3,
      isCancelled: () => false,
      load: async (item) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return [item];
      },
      commit: (_item, results) => committed.push(...results),
    });
    assert.equal(peakActive, 2);
    assert.deepEqual(committed, [1, 2, 3]);
    assert.equal(summary.results, 3);
    assert.equal(summary.truncated, true);
  });

  it('取消后不再提交已经开始但尚未完成的读取结果', async () => {
    let cancelled = false;
    const committed: number[] = [];
    const summary = await runTodoScanEngine({
      items: [1, 2, 3, 4],
      concurrency: 2,
      isCancelled: () => cancelled,
      load: async (item) => {
        if (item === 1) cancelled = true;
        await Promise.resolve();
        return [item];
      },
      commit: (_item, results) => committed.push(...results),
    });
    assert.deepEqual(committed, []);
    assert.equal(summary.cancelled, true);
    assert.equal(summary.results, 0);
  });
});
