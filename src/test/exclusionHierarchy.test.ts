import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  consolidateHierarchicalResources,
  isDescendantPattern,
  stripRecursiveSuffix,
} from '../exclusions/exclusionHierarchy';

describe('屏蔽路径层级', () => {
  it('识别目录子孙规则', () => {
    assert.equal(isDescendantPattern('a/b/**', 'a'), true);
    assert.equal(isDescendantPattern('a-b/c', 'a'), false);
    assert.equal(isDescendantPattern('a', 'a'), false);
  });

  it('移除递归后缀后比较路径', () => {
    assert.equal(stripRecursiveSuffix('a/b/**'), 'a/b');
    assert.equal(isDescendantPattern('a/b/c.txt', 'a/**'), true);
  });

  it('同一次选择父目录和子项时只保留父目录', () => {
    const result = consolidateHierarchicalResources([
      { relativePath: 'a/b', kind: 'directory' as const, value: 'child' },
      { relativePath: 'a', kind: 'directory' as const, value: 'parent' },
      { relativePath: 'a/b/file.txt', kind: 'file' as const, value: 'file' },
    ]);
    assert.deepEqual(result.map((item) => item.value), ['parent']);
  });

  it('名称前缀相同但没有目录层级关系时全部保留', () => {
    const result = consolidateHierarchicalResources([
      { relativePath: 'a', kind: 'directory' as const, value: 'a' },
      { relativePath: 'a-other', kind: 'directory' as const, value: 'a-other' },
    ]);
    assert.deepEqual(result.map((item) => item.value), ['a', 'a-other']);
  });
});
