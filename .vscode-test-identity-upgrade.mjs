import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

// 仅用于单阶段诊断。test-cli 启用内存存储，不能用此配置证明跨进程持久化；完整验证使用 scripts/test-identity-upgrade.mjs。

const root = path.dirname(fileURLToPath(import.meta.url));
const directory = process.env.CATLAS_MIGRATION_TEST_DIRECTORY;
const phase = process.env.CATLAS_MIGRATION_TEST_PHASE;
const candidate = process.env.CATLAS_MIGRATION_TEST_PACKAGE;
if (!directory || !path.isAbsolute(directory) || !candidate || !path.isAbsolute(candidate)
  || !['export', 'import', 'verify'].includes(phase)) throw new Error('必须由迁移测试脚本提供准确路径和阶段。');
export default defineConfig({
  label: 'identityUpgrade', files: 'dist/integrationTest/identityUpgrade.test.js',
  version: process.env.PROJECT_BUTLER_TEST_VSCODE_VERSION ?? '1.88.0',
  extensionDevelopmentPath: path.join(root, 'test-fixtures/test-harness-extension'),
  workspaceFolder: path.join(root, 'test-fixtures/workspace-one'),
  // 安装由脚本显式指定隔离目录；test-cli 的安装器不透传 launchArgs 中的目录。
  skipExtensionDependencies: true,
  launchArgs: [
    `--user-data-dir=${path.join(directory, 'user-data')}`,
    `--extensions-dir=${path.join(directory, 'extensions')}`,
    '--disable-extension', phase === 'export' ? 'scnable.catlas-hub' : 'local-development.project-butler',
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
  ],
  mocha: { ui: 'tdd', timeout: 30000, color: true },
});
