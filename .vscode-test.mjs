import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  {
    label: 'extensionHost',
    files: [
      'dist/integrationTest/extensionHost.test.js',
      'dist/integrationTest/configuration.test.js',
      'dist/integrationTest/contextAndCatalog.test.js',
      'dist/integrationTest/tabs.test.js',
      'dist/integrationTest/exclusions.test.js',
      'dist/integrationTest/externalFiles.test.js',
      'dist/integrationTest/outline.test.js',
      'dist/integrationTest/buildAndSafety.test.js',
    ],
    version: 'stable',
    extensionDevelopmentPath: projectRoot,
    workspaceFolder: path.join(projectRoot, 'test-fixtures', 'workspace-one'),
    launchArgs: [
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
    mocha: {
      ui: 'tdd',
      timeout: 30_000,
      color: true,
    },
  },
  {
    label: 'installedVsix',
    files: 'dist/integrationTest/installedVsix.test.js',
    version: 'stable',
    extensionDevelopmentPath: path.join(projectRoot, 'test-fixtures', 'test-harness-extension'),
    workspaceFolder: path.join(projectRoot, 'test-fixtures', 'workspace-one'),
    installExtensions: [path.join(projectRoot, 'releases', 'project-butler-0.7.5-preview-test-r16.vsix')],
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
  },
]);
