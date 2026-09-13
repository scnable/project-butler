import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { createVSIX } from '@vscode/vsce';

// 导入函数做单元测试时不生成安装包，也不启动 VS Code。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

async function main() {
  const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const args = process.argv.slice(2);
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const stage = readStage(args);
  if (stage === 'stable') {
    validateStableManifest(manifest);
    await access(path.join(projectRoot, 'LICENSE'));
  }
  const requestedOutput = readOutputArgument(args)
    ?? `releases/${manifest.name}-${manifest.version}${stage === 'stable' ? '' : `-${stage}`}.vsix`;
  await mkdir(path.join(projectRoot, 'releases'), { recursive: true });
  const outputPath = await findAvailableOutput(projectRoot, requestedOutput);
  await createVSIX({ cwd: projectRoot, packagePath: outputPath, preRelease: stage !== 'stable', dependencies: false });
  const packageStat = await stat(outputPath);
  if (!packageStat.isFile() || packageStat.size === 0) throw new Error(`VSIX 生成结果无效：${outputPath}`);
  const sha256 = await hashPackage(outputPath);
  console.log(`${stage === 'stable' ? '正式包' : stage === 'preview' ? '预览正式包' : '预览测试包'}已生成：${path.relative(projectRoot, outputPath)}（${packageStat.size} 字节）`);
  // 结构化结果用于本地自动化；测试直接继承本轮准确路径，绝不猜测目录中哪个包最新。
  console.log(JSON.stringify({ packagePath: outputPath, version: manifest.version, stage, sha256 }));
  if (args.includes('--test')) {
    const env = { ...process.env, PROJECT_BUTLER_TEST_VSIX: outputPath,
      PROJECT_BUTLER_TEST_VERSION: manifest.version,
      PROJECT_BUTLER_TEST_ID: `${manifest.publisher}.${manifest.name}`,
      PROJECT_BUTLER_TEST_SHA256: sha256 };
    const cli = path.join(projectRoot, 'node_modules/@vscode/test-cli/out/bin.mjs');
    for (const label of ['todoOomRegression', 'extensionHost', 'installedVsix']) {
      await run(process.execPath, [cli, '--label', label], projectRoot, env);
      if (await hashPackage(outputPath) !== sha256) throw new Error('测试期间安装包发生变化，禁止继续发布。');
    }
    console.log('同一候选包的 OOM、源码宿主和安装态验证全部完成。');
  }
}

export function readStage(args) {
  const index = args.indexOf('--stage');
  const stage = index < 0 ? 'preview-test' : args[index + 1];
  if (!['preview-test', 'preview', 'stable'].includes(stage)) throw new Error('发布阶段必须是 preview-test、preview 或 stable。');
  return stage;
}

export function validateStableManifest(manifest) {
  if (!manifest.publisher || manifest.publisher === 'local-development'
    || !manifest.name || !manifest.displayName || !manifest.license || manifest.license === 'UNLICENSED'
    || !manifest.icon || !manifest.homepage || !manifest.bugs
    || !/^[1-9]\d*\.\d+\.\d+$/.test(manifest.version ?? '')) {
    throw new Error('正式包需要正式版本、名称、Publisher、许可证、图标、主页和问题反馈地址。');
  }
}

async function hashPackage(filename) {
  return createHash('sha256').update(await readFile(filename)).digest('hex');
}

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`测试失败：${args.at(-1)}，退出码 ${code}，信号 ${signal}`)));
  });
}

function readOutputArgument(args) {
  const outputIndex = args.indexOf('--out');
  if (outputIndex < 0) return undefined;
  const value = outputIndex < 0 ? undefined : args[outputIndex + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error('必须通过 --out 指定候选包起始名称。');
  }
  return value;
}

export async function findAvailableOutput(root, requested) {
  const absoluteRequested = path.resolve(root, requested);
  const releasesRoot = path.resolve(root, 'releases');
  const relativeToReleases = path.relative(releasesRoot, absoluteRequested);
  if (relativeToReleases.startsWith('..') || path.isAbsolute(relativeToReleases)) {
    throw new Error(`候选包必须位于 releases 目录：${requested}`);
  }

  const extension = path.extname(absoluteRequested);
  if (extension.toLowerCase() !== '.vsix') {
    throw new Error(`候选包名称必须以 .vsix 结尾：${requested}`);
  }

  const withoutExtension = absoluteRequested.slice(0, -extension.length);
  const revisionMatch = /^(.*)-r(\d+)$/u.exec(withoutExtension);
  const basePath = revisionMatch?.[1] ?? withoutExtension;
  let revision = revisionMatch === null ? 1 : Number.parseInt(revisionMatch[2], 10);

  while (true) {
    const candidate = revision === 1
      ? `${basePath}${extension}`
      : `${basePath}-r${revision}${extension}`;
    if (!await pathExists(candidate)) return candidate;
    revision += 1;
  }
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}
