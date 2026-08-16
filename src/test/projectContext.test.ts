import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyProjectContext } from '../projectCatalog/projectContext';

describe('运行项目归属', () => {
  it('精确匹配当前项目键时识别为集合内项目', () => {
    assert.deepEqual(classifyProjectContext(true, 'file:///workspace-a', [
      { projectIndex: 0, key: 'file:///workspace-b' },
      { projectIndex: 1, key: 'file:///workspace-a' },
    ]), { kind: 'member', projectIndex: 1 });
  });

  it('有工作区但没有匹配项目时识别为集合外项目', () => {
    assert.deepEqual(classifyProjectContext(true, 'file:///standalone', [
      { projectIndex: 0, key: 'file:///workspace-a' },
    ]), { kind: 'external' });
  });

  it('没有工作区时识别为集合启动窗口', () => {
    assert.deepEqual(classifyProjectContext(false, undefined, []), { kind: 'noWorkspace' });
  });

  it('无法生成稳定项目键的工作区不会猜测集合成员', () => {
    assert.deepEqual(classifyProjectContext(true, undefined, [
      { projectIndex: 0, key: 'file:///workspace-a' },
    ]), { kind: 'external' });
  });
});
