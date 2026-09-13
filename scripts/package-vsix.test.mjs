import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readStage, validateStableManifest, findAvailableOutput } from './package-vsix.mjs';

test('发布阶段默认预览测试，支持预览正式与正式，拒绝未知值', () => {
  assert.equal(readStage([]), 'preview-test');
  assert.equal(readStage(['--stage', 'preview']), 'preview');
  assert.equal(readStage(['--stage', 'stable']), 'stable');
  assert.throws(() => readStage(['--stage']));
  assert.throws(() => readStage(['--stage', 'beta']));
});

test('正式构建拒绝临时身份、许可证和不完整元数据', () => {
  const manifest = { name: 'example', displayName: '示例', version: '1.0.0', publisher: 'example',
    license: 'MIT', icon: 'icon.png', homepage: 'https://example.com', bugs: 'https://example.com/issues' };
  assert.doesNotThrow(() => validateStableManifest(manifest));
  for (const field of ['name', 'displayName', 'publisher', 'license', 'icon', 'homepage', 'bugs']) {
    assert.throws(() => validateStableManifest({ ...manifest, [field]: '' }));
  }
  assert.throws(() => validateStableManifest({ ...manifest, publisher: 'local-development' }));
  assert.throws(() => validateStableManifest({ ...manifest, license: 'UNLICENSED' }));
  assert.throws(() => validateStableManifest({ ...manifest, version: '0.10.0' }));
});

test('安装包路径不得越过 releases，必须使用 VSIX 扩展名', async () => {
  const root = process.cwd();
  await assert.rejects(findAvailableOutput(root, '../outside.vsix'));
  await assert.rejects(findAvailableOutput(root, 'releases/../../outside.vsix'));
  await assert.rejects(findAvailableOutput(root, 'releases/package.zip'));
  const candidate = await findAvailableOutput(root, 'releases/release-tool-unit-test.vsix');
  assert.equal(path.dirname(candidate), path.resolve(root, 'releases'));
});
