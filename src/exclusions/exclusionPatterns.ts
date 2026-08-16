export type ResourceKind = 'file' | 'directory';

export interface ExclusionPatternSet {
  readonly explorer: string;
  readonly search: string;
  readonly watcher: string;
}

export function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');

  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`无效的工作区相对路径: ${relativePath}`);
  }

  return normalized;
}

export function escapeGlobPath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  let escaped = '';

  for (const character of normalized) {
    switch (character) {
      case '*':
        escaped += '[*]';
        break;
      case '?':
        escaped += '[?]';
        break;
      case '[':
        escaped += '[[]';
        break;
      case ']':
        escaped += '[]]';
        break;
      case '{':
        escaped += '[{]';
        break;
      case '}':
        escaped += '[}]';
        break;
      default:
        escaped += character;
    }
  }

  return escaped;
}

export function buildExclusionPatterns(
  relativePath: string,
  kind: ResourceKind,
): ExclusionPatternSet {
  const escapedPath = escapeGlobPath(relativePath);
  const recursivePath = kind === 'directory' ? `${escapedPath}/**` : escapedPath;

  return {
    explorer: escapedPath,
    search: recursivePath,
    watcher: recursivePath,
  };
}

export function buildFileTypeExclusionPattern(extension: string): string {
  if (!extension.startsWith('.') || extension.length < 2 || extension.includes('/') || extension.includes('\\')) {
    throw new Error(`无效的文件扩展名: ${extension}`);
  }
  return `**/*${escapeGlobLiteral(extension)}`;
}

function escapeGlobLiteral(value: string): string {
  let escaped = '';
  for (const character of value) {
    switch (character) {
      case '*': escaped += '[*]'; break;
      case '?': escaped += '[?]'; break;
      case '[': escaped += '[[]'; break;
      case ']': escaped += '[]]'; break;
      case '{': escaped += '[{]'; break;
      case '}': escaped += '[}]'; break;
      default: escaped += character;
    }
  }
  return escaped;
}
