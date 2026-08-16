import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const baselineDirectory = path.join(projectRoot, 'media', 'icons', 'baseline');
const manifestPath = path.join(baselineDirectory, 'manifest.json');

const mode = process.argv[2] ?? '--check';
if (!['--check', '--write'].includes(mode)) {
  throw new Error('用法：node scripts/generate-icons.mjs --check|--write');
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const normalize = (value) => value.replace(/\r\n/g, '\n').trimEnd() + '\n';
const manifest = await readJson(manifestPath);
const palettePath = path.resolve(baselineDirectory, manifest.palette);
const palette = await readJson(palettePath);
const mismatches = [];

function render(template, tokens, iconId, paletteMode) {
  const rendered = template.replace(/\{\{([a-z][a-z0-9-]*)\}\}/g, (_, token) => {
    const value = tokens[token];
    if (typeof value !== 'string') {
      throw new Error(`${iconId}/${paletteMode} 缺少调色板令牌：${token}`);
    }
    return value;
  });
  const unresolved = rendered.match(/\{\{[^}]+\}\}/g);
  if (unresolved) {
    throw new Error(`${iconId}/${paletteMode} 存在未解析令牌：${unresolved.join(', ')}`);
  }
  return normalize(rendered);
}

for (const icon of manifest.icons) {
  const sourcePath = path.resolve(baselineDirectory, manifest.sourceRoot, icon.source);
  const template = await fs.readFile(sourcePath, 'utf8');
  for (const [paletteMode, relativeOutput] of Object.entries(icon.files)) {
    const modePalette = palette.modes[paletteMode];
    if (!modePalette) throw new Error(`缺少调色模式：${paletteMode}`);
    const tokens = { ...(modePalette['*'] ?? {}), ...(modePalette[icon.id] ?? {}) };
    const expected = render(template, tokens, icon.id, paletteMode);
    const outputPath = path.resolve(baselineDirectory, relativeOutput);

    if (mode === '--write') {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, expected, 'utf8');
      continue;
    }

    let actual;
    try {
      actual = normalize(await fs.readFile(outputPath, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        mismatches.push(`${icon.id}/${paletteMode}: 缺少 ${relativeOutput}`);
        continue;
      }
      throw error;
    }
    if (actual !== expected) mismatches.push(`${icon.id}/${paletteMode}: ${relativeOutput} 与源稿或调色板不一致`);
  }
}

if (mismatches.length > 0) {
  for (const mismatch of mismatches) console.error(mismatch);
  console.error('请运行 npm run icons:generate 重新生成资源。');
  process.exitCode = 1;
} else {
  console.log(`图标资源检查通过：${manifest.icons.length} 个源稿，${manifest.icons.length * 3} 个运行时 SVG。`);
}
