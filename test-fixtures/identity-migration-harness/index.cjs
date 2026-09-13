// 仅在项目隔离目录使用。普通开发宿主保留磁盘存储，不能传 extensionTestsPath，后者会使用内存存储。
const path = require('node:path');
const { writeFile } = require('node:fs/promises');
const vscode = require('vscode');
exports.activate = async function () {
  const directory = process.env.CATLAS_MIGRATION_TEST_DIRECTORY;
  const phase = process.env.CATLAS_MIGRATION_TEST_PHASE;
  if (!directory || !path.isAbsolute(directory) || !['export', 'import', 'verify'].includes(phase)) return;
  const tasks = [];
  global.suite = (_name, body) => body();
  global.test = (_name, body) => tasks.push(body);
  let result;
  try {
    require('../../dist/integrationTest/identityUpgrade.test.js');
    if (tasks.length !== 1) throw new Error('迁移测试项数量异常');
    for (const task of tasks) await task();
    result = { phase, passed: true };
  } catch (error) {
    result = { phase, passed: false, message: String(error) };
  }
  await writeFile(path.join(directory, `${phase}-result.json`), JSON.stringify(result), { flag: 'wx' });
  // 正常退出，让 VS Code 完成 Memento 落盘；不用强制终止代替重启。
  await vscode.commands.executeCommand('workbench.action.quit');
};
