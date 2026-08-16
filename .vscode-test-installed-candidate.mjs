import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const candidatePath = process.env.PROJECT_BUTLER_TEST_VSIX;

if (!candidatePath) {
  throw new Error('请通过 PROJECT_BUTLER_TEST_VSIX 指定待验证的 VSIX 路径。');
}

export default defineConfig({
  label: 'installedCandidate',
  files: 'dist/integrationTest/installedVsix.test.js',
  version: 'stable',
  extensionDevelopmentPath: path.join(projectRoot, 'test-fixtures', 'test-harness-extension'),
  workspaceFolder: path.join(projectRoot, 'test-fixtures', 'workspace-one'),
  installExtensions: [path.resolve(projectRoot, candidatePath)],
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
