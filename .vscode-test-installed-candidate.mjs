import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
// 源码、OOM 和安装态窗口共用隔离参数；新版 VS Code 的共享存储不随 user-data-dir 自动隔离。
export const isolatedStorageArgs = [
  `--shared-data-dir=${path.join(projectRoot, '.vscode-test', 'shared-data')}`,
  '--use-inmemory-secretstorage',
];
// 三类测试共用版本选择，防止源码在旧版运行、安装态却验证了最新版。
export const testVscodeVersion = process.env.PROJECT_BUTLER_TEST_VSCODE_VERSION ?? 'stable';
if (!/^(stable|\d+\.\d+\.\d+)$/.test(testVscodeVersion)) {
  throw new Error('PROJECT_BUTLER_TEST_VSCODE_VERSION 必须为 stable 或准确的三段版本号。');
}
const candidatePath = process.env.PROJECT_BUTLER_TEST_VSIX;

if (!candidatePath) {
  throw new Error('请通过 PROJECT_BUTLER_TEST_VSIX 指定待验证的 VSIX 路径。');
}
const resolvedCandidate = path.resolve(projectRoot, candidatePath);
if (!statSync(resolvedCandidate).isFile() || !resolvedCandidate.endsWith('.vsix')) {
  throw new Error('候选包必须是存在的 VSIX 文件。');
}
const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const expectedHash = process.env.PROJECT_BUTLER_TEST_SHA256;
if (!expectedHash || createHash('sha256').update(readFileSync(resolvedCandidate)).digest('hex') !== expectedHash) {
  throw new Error('候选包缺少 SHA-256 或与本次构建结果不一致。');
}
if (process.env.PROJECT_BUTLER_TEST_VERSION !== manifest.version
  || process.env.PROJECT_BUTLER_TEST_ID !== `${manifest.publisher}.${manifest.name}`) {
  throw new Error('本次测试的预期版本或扩展 ID 与项目清单不一致。');
}

export const candidateConfig = {
  label: 'installedCandidate',
  files: 'dist/integrationTest/installedVsix.test.js',
  version: testVscodeVersion,
  extensionDevelopmentPath: path.join(projectRoot, 'test-fixtures', 'test-harness-extension'),
  workspaceFolder: path.join(projectRoot, 'test-fixtures', 'workspace-one'),
  installExtensions: [resolvedCandidate],
  skipExtensionDependencies: true,
  launchArgs: [
    ...isolatedStorageArgs,
    // 只在测试窗口禁用旧身份，不卸载旧包，也不修改用户日常启用状态。
    '--disable-extension', 'local-development.project-butler',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
  ],
  mocha: {
    ui: 'tdd',
    timeout: 30_000,
    color: true,
  },
};
export default defineConfig(candidateConfig);
