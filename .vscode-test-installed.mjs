import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const requestedVsix = process.env.PROJECT_BUTLER_TEST_VSIX;

if (requestedVsix === undefined || requestedVsix.trim().length === 0) {
  throw new Error('运行安装态测试前必须设置 PROJECT_BUTLER_TEST_VSIX。');
}

const testVsix = path.isAbsolute(requestedVsix)
  ? requestedVsix
  : path.join(projectRoot, requestedVsix);

export default defineConfig({
  label: 'installedVsixOverride',
  files: 'dist/integrationTest/installedVsix.test.js',
  version: 'stable',
  extensionDevelopmentPath: path.join(projectRoot, 'test-fixtures', 'test-harness-extension'),
  workspaceFolder: path.join(projectRoot, 'test-fixtures', 'workspace-one'),
  installExtensions: [testVsix],
  skipExtensionDependencies: true,
  launchArgs: [
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
  ],
  mocha: {
    ui: 'tdd',
    timeout: 30_000,
    color: true,
  },
});
