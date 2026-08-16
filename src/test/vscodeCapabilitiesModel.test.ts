import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isRegisteredCommand, resolveVscodeCapabilities } from '../platform/vscodeCapabilitiesModel';

describe('VS Code 能力模型', () => {
  it('最低支持版本没有注册 AI 设置时明确判定为不支持', () => {
    const capabilities = resolveVscodeCapabilities('1.88.0', { chatDisableAiFeatures: false });

    assert.equal(capabilities.chatDisableAiFeatures.supported, false);
    assert.equal(capabilities.chatDisableAiFeatures.minimumVersion, '1.104.0');
    assert.match(capabilities.chatDisableAiFeatures.reason ?? '', /1\.104/);
  });

  it('版本达到边界且设置已注册时判定为支持', () => {
    const capabilities = resolveVscodeCapabilities('1.104.0', { chatDisableAiFeatures: true });

    assert.equal(capabilities.chatDisableAiFeatures.supported, true);
    assert.equal(capabilities.chatDisableAiFeatures.reason, undefined);
  });

  it('版本较新但设置没有注册时仍以能力检测结果降级', () => {
    const capabilities = resolveVscodeCapabilities('1.133.0', { chatDisableAiFeatures: false });

    assert.equal(capabilities.chatDisableAiFeatures.supported, false);
  });

  it('内置命令只有实际注册时才判定为可用', () => {
    const commands = ['outline.focus', 'workbench.extensions.search'];

    assert.equal(isRegisteredCommand('outline.focus', commands), true);
    assert.equal(isRegisteredCommand('missing.command', commands), false);
    assert.equal(isRegisteredCommand('', commands), false);
  });
});
