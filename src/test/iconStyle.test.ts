import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ICON_STYLES, normalizeIconStyle } from '../visual/iconStyle';

describe('统一图标风格', () => {
  it('只公开统一标识与 VS Code 原生两种风格', () => {
    assert.deepEqual(ICON_STYLES, ['unified', 'native']);
  });

  it('识别原生风格', () => {
    assert.equal(normalizeIconStyle('native'), 'native');
  });

  it('缺失或未知值安全回退到统一标识', () => {
    assert.equal(normalizeIconStyle(undefined), 'unified');
    assert.equal(normalizeIconStyle('future-style'), 'unified');
    assert.equal(normalizeIconStyle(1), 'unified');
  });
});
