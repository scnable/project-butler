// 用独立用户目录连续启动三个宿主，验证已安装旧包导出、新包暂存、再次启动后恢复。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runVSCodeCommand, downloadAndUnzipVSCode } from '@vscode/test-electron';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const [oldPath, newPath] = process.argv.slice(2).map((value) => path.resolve(root, value));
if (!oldPath || !newPath || !oldPath.endsWith('.vsix') || !newPath.endsWith('.vsix')) throw new Error('请提供旧身份包和正式身份包两个准确路径。');
const hash = async (filename) => createHash('sha256').update(await readFile(filename)).digest('hex');
const before = [await hash(oldPath), await hash(newPath)];
await mkdir(path.join(root, '.vscode-test'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.vscode-test/identity-upgrade-'));
console.log(`迁移测试数据保留于：${directory}`);
// 较新版本另有跨配置文件的共享目录，仅 user-data-dir 不足以隔离它。
const sharedArguments = [`--shared-data-dir=${path.join(directory, 'shared-data')}`, '--use-inmemory-secretstorage'];
const executable = await downloadAndUnzipVSCode(process.env.PROJECT_BUTLER_TEST_VSCODE_VERSION ?? '1.88.0');
for (const phase of ['export', 'import', 'verify']) {
  const candidate = phase === 'export' ? oldPath : newPath;
  if (phase !== 'verify') {
    await runVSCodeCommand(['--install-extension', candidate, ...sharedArguments,
      `--user-data-dir=${path.join(directory, 'user-data')}`,
      `--extensions-dir=${path.join(directory, 'extensions')}`],
    { version: process.env.PROJECT_BUTLER_TEST_VSCODE_VERSION ?? '1.88.0' });
  }
  const result = spawnSync(executable, [
    ...sharedArguments,
    `--user-data-dir=${path.join(directory, 'user-data')}`,
    `--extensions-dir=${path.join(directory, 'extensions')}`,
    `--extensionDevelopmentPath=${path.join(root, 'test-fixtures/identity-migration-harness')}`,
    '--disable-extension', phase === 'export' ? 'scnable.catlas-hub' : 'local-development.project-butler',
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates',
    path.join(root, 'test-fixtures/workspace-one'),
  ], {
    cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env,
      CATLAS_MIGRATION_TEST_DIRECTORY: directory, CATLAS_MIGRATION_TEST_PHASE: phase, CATLAS_MIGRATION_TEST_PACKAGE: candidate },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const report = JSON.parse(await readFile(path.join(directory, `${phase}-result.json`), 'utf8'));
  console.log(report);
  if (!report.passed) process.exit(1);
  if (await hash(oldPath) !== before[0] || await hash(newPath) !== before[1]) throw new Error('迁移测试期间包发生变化。');
}
console.log('旧包导出、新包导入、真实重启后恢复三阶段通过。');
