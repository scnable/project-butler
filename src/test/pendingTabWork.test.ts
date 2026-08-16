import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { choosePendingGroupAction, PendingGroupSnapshot } from '../tabManagement/pendingTabWork';

function pending(
  fullReconcile = false,
  textTabIds: readonly string[] = [],
  auxiliaryTabIds: readonly string[] = [],
): PendingGroupSnapshot {
  return { fullReconcile, textTabIds, auxiliaryTabIds };
}

describe('标签组待整理触发', () => {
  it('开关开启后的完整整理只在特殊标签活动时等待', () => {
    assert.deepEqual(
      choosePendingGroupAction(pending(true), 'settings', 'auxiliary'),
      { kind: 'wait' },
    );
    assert.deepEqual(
      choosePendingGroupAction(pending(true), 'preview', 'blockedText'),
      { kind: 'reconcileAll' },
    );
    assert.deepEqual(
      choosePendingGroupAction(pending(true), 'project-file', 'movableText'),
      { kind: 'reconcileAll' },
    );
  });

  it('快速切换后仍保留全部新普通文件并在安全时一起处理', () => {
    assert.deepEqual(
      choosePendingGroupAction(
        pending(false, ['project-file', 'external-file']),
        'another-project-file',
        'movableText',
      ),
      { kind: 'placeTextTabs', tabIds: ['project-file', 'external-file'] },
    );
  });

  it('新打开的特殊标签只有在自身处于活动状态时移动', () => {
    const snapshot = pending(false, [], ['settings']);
    assert.deepEqual(
      choosePendingGroupAction(snapshot, 'project-file', 'movableText'),
      { kind: 'none' },
    );
    assert.deepEqual(
      choosePendingGroupAction(snapshot, 'settings', 'auxiliary'),
      { kind: 'placeAuxiliaryTab', tabId: 'settings' },
    );
  });

  it('没有待处理工作时不执行动作', () => {
    assert.deepEqual(
      choosePendingGroupAction(pending(), 'project-file', 'movableText'),
      { kind: 'none' },
    );
  });
});
