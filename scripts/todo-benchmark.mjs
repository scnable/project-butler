import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runTodoScanEngine, TODO_SCAN_CONCURRENCY, TODO_SCAN_MAX_RESULTS } = require('../dist/todo/todoScanEngine.js');
const { parseTodoText } = require('../dist/todo/todoParser.js');
const { createTodoTagDefinitions } = require('../dist/todo/todoTags.js');
const { getTodoCommentSyntax } = require('../dist/todo/todoCommentSyntax.js');

const parseOptions = {
  tags: createTodoTagDefinitions(['TODO', 'FIXME', 'BUG', 'HACK', 'XXX']),
  markdownTasks: false,
  lineCommentTokens: getTodoCommentSyntax('typescript').lineTokens,
  blockCommentTokens: getTodoCommentSyntax('typescript').blockTokens,
};

function heapMiB() {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function createSyntheticWorkspace(discoveredFiles, dense = false) {
  const started = performance.now();
  const files = Array.from({ length: discoveredFiles }, (_, index) => ({
    path: `src/module-${Math.trunc(index / 100)}/file-${index}.ts`,
    text: dense || index % 20 === 0
      ? `export const value${index} = ${index};\n// TODO: synthetic-${index}\n`
      : `export const value${index} = ${index};\n// ordinary comment\n`,
  }));
  const candidates = files.filter((file) => file.path.endsWith('.ts'));
  return { candidates, enumerationMs: performance.now() - started };
}

async function runScenario(discoveredFiles, dense = false) {
  global.gc?.();
  const workspace = createSyntheticWorkspace(discoveredFiles, dense);
  const baselineHeap = heapMiB();
  let peakHeap = baselineHeap;
  let progressEvents = 0;
  const index = new Map();
  const started = performance.now();
  const summary = await runTodoScanEngine({
    items: workspace.candidates,
    concurrency: TODO_SCAN_CONCURRENCY,
    maxResults: TODO_SCAN_MAX_RESULTS,
    isCancelled: () => false,
    load: async (file) => {
      await Promise.resolve();
      return parseTodoText(file.text, parseOptions);
    },
    commit: (file, matches) => {
      if (matches.length > 0) index.set(file.path, matches);
    },
    onProgress: () => {
      progressEvents += 1;
      if (progressEvents % 64 === 0) peakHeap = Math.max(peakHeap, heapMiB());
    },
  });
  peakHeap = Math.max(peakHeap, heapMiB());
  return {
    discoveredFiles,
    candidateFiles: workspace.candidates.length,
    enumerationMs: workspace.enumerationMs,
    scanMs: performance.now() - started,
    peakHeapDeltaMiB: Math.max(0, peakHeap - baselineHeap),
    files: summary.files,
    results: summary.results,
    truncated: summary.truncated,
    indexedFiles: index.size,
  };
}

async function runCancellationScenario() {
  const workspace = createSyntheticWorkspace(20_000, false);
  let cancelled = false;
  let cancelledAt;
  let filesAtCancellation = 0;
  const started = performance.now();
  const summary = await runTodoScanEngine({
    items: workspace.candidates,
    concurrency: TODO_SCAN_CONCURRENCY,
    maxResults: TODO_SCAN_MAX_RESULTS,
    isCancelled: () => cancelled,
    load: async (file) => {
      await Promise.resolve();
      return parseTodoText(file.text, parseOptions);
    },
    commit: () => {},
    onProgress: (progress) => {
      if (!cancelled && progress.files >= 1_000) {
        cancelled = true;
        filesAtCancellation = progress.files;
        cancelledAt = performance.now();
      }
    },
  });
  const completedAt = performance.now();
  return {
    totalMs: completedAt - started,
    cancellationLatencyMs: completedAt - cancelledAt,
    filesAtCancellation,
    finalFiles: summary.files,
    growthAfterCancellation: summary.files - filesAtCancellation,
    cancelled: summary.cancelled,
  };
}

await runScenario(100);
const normal = [];
for (const size of [1_000, 5_000, 20_000]) normal.push(await runScenario(size));
const limit = await runScenario(6_000, true);
const cancellation = await runCancellationScenario();

for (const result of normal) {
  assert.equal(result.files, result.candidateFiles);
  assert.equal(result.truncated, false);
}
assert.equal(limit.results, TODO_SCAN_MAX_RESULTS);
assert.equal(limit.truncated, true);
assert.equal(cancellation.cancelled, true);
assert.ok(cancellation.cancellationLatencyMs < 500, `取消延迟 ${cancellation.cancellationLatencyMs.toFixed(2)} ms 超过 500 ms`);
assert.ok(cancellation.growthAfterCancellation <= TODO_SCAN_CONCURRENCY);

console.log(`TODO 内存合成工作区性能基准（${process.platform} ${process.arch}，${process.version}）`);
console.table(normal.map((result) => ({
  文件数: result.discoveredFiles,
  枚举筛选毫秒: result.enumerationMs.toFixed(2),
  扫描毫秒: result.scanMs.toFixed(2),
  峰值堆增量MiB: result.peakHeapDeltaMiB.toFixed(2),
  结果数: result.results,
})));
console.log('结果上限：', JSON.stringify(limit));
console.log('取消行为：', JSON.stringify(cancellation));
