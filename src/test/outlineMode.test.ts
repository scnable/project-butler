import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  isEnhancedOutlineEnabled,
  resolveNativeOutlineConflict,
  isNativeOutlineNoticeVisible,
  shouldShowNativeOutlineNotice,
} from '../symbolOutline/outlineMode';

describe('大纲模式状态转换', () => {
  it('用户选择同时使用时进入 both 模式', () => {
    assert.equal(resolveNativeOutlineConflict('both'), 'both');
  });

  it('用户选择仅原生时进入 native 模式', () => {
    assert.equal(resolveNativeOutlineConflict('native'), 'native');
  });

  it('冲突提示被关闭或没有选择时安全回退为仅原生', () => {
    assert.equal(resolveNativeOutlineConflict(undefined), 'native');
  });

  it('只有 enhanced 和 both 模式启用增强大纲', () => {
    assert.equal(isEnhancedOutlineEnabled('native'), false);
    assert.equal(isEnhancedOutlineEnabled('enhanced'), true);
    assert.equal(isEnhancedOutlineEnabled('both'), true);
  });

  it('只有仅增强模式在增强大纲内部常驻显示原生大纲隐藏提示', () => {
    assert.equal(shouldShowNativeOutlineNotice('native'), false);
    assert.equal(shouldShowNativeOutlineNotice('enhanced'), true);
    assert.equal(shouldShowNativeOutlineNotice('both'), false);
  });

  it('仅增强模式显示可折叠的原生大纲说明', () => {
    assert.equal(isNativeOutlineNoticeVisible('enhanced'), true);
    assert.equal(isNativeOutlineNoticeVisible('both'), false);
    assert.equal(isNativeOutlineNoticeVisible('native'), false);
  });
});
