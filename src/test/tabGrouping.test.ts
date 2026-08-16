import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  GroupableTab,
  isSameOrder,
  moveNonProjectTabsToTail,
} from '../tabManagement/tabGrouping';

function tab(
  id: string,
  category: GroupableTab['category'] = 'project',
): GroupableTab {
  return { id, category };
}

describe('非项目标签稳定移至末尾', () => {
  it('项目内文件保持用户顺序', () => {
    const tabs = [
      tab('a1'),
      tab('b1'),
      tab('a2'),
      tab('b2'),
    ];
    assert.deepEqual(moveNonProjectTabsToTail(tabs), ['a1', 'b1', 'a2', 'b2']);
  });

  it('外部与特殊标签稳定排在项目标签之后', () => {
    const tabs = [
      tab('external1', 'external'),
      tab('project1'),
      tab('special', 'external'),
      tab('project2'),
      tab('external2', 'external'),
    ];
    assert.deepEqual(moveNonProjectTabsToTail(tabs), ['project1', 'project2', 'external1', 'special', 'external2']);
  });

  it('非项目标签之间保持原顺序', () => {
    const tabs = [
      tab('external1', 'external'),
      tab('project'),
      tab('external2', 'external'),
    ];
    assert.deepEqual(moveNonProjectTabsToTail(tabs), ['project', 'external1', 'external2']);
  });

  it('比较当前顺序和目标顺序', () => {
    assert.equal(isSameOrder(['a', 'b'], ['a', 'b']), true);
    assert.equal(isSameOrder(['a', 'b'], ['b', 'a']), false);
  });

});
