export interface TodoCommentSyntax {
  readonly lineTokens: readonly string[];
  readonly blockTokens: readonly { readonly open: string; readonly close: string }[];
}

const C_STYLE: TodoCommentSyntax = {
  lineTokens: ['//'],
  blockTokens: [{ open: '/*', close: '*/' }],
};
const HASH_STYLE: TodoCommentSyntax = { lineTokens: ['#'], blockTokens: [] };

const LANGUAGE_SYNTAX: Readonly<Record<string, TodoCommentSyntax>> = {
  c: C_STYLE,
  cpp: C_STYLE,
  'cuda-cpp': C_STYLE,
  csharp: C_STYLE,
  java: C_STYLE,
  javascript: C_STYLE,
  javascriptreact: C_STYLE,
  typescript: C_STYLE,
  typescriptreact: C_STYLE,
  go: C_STYLE,
  rust: C_STYLE,
  swift: C_STYLE,
  kotlin: C_STYLE,
  php: { lineTokens: ['//', '#'], blockTokens: C_STYLE.blockTokens },
  python: HASH_STYLE,
  ruby: HASH_STYLE,
  shellscript: HASH_STYLE,
  makefile: HASH_STYLE,
  yaml: HASH_STYLE,
  dockerfile: HASH_STYLE,
  powershell: { lineTokens: ['#'], blockTokens: [{ open: '<#', close: '#>' }] },
  lua: { lineTokens: ['--'], blockTokens: [{ open: '--[[', close: ']]' }] },
  sql: { lineTokens: ['--'], blockTokens: C_STYLE.blockTokens },
  html: { lineTokens: [], blockTokens: [{ open: '<!--', close: '-->' }] },
  xml: { lineTokens: [], blockTokens: [{ open: '<!--', close: '-->' }] },
  css: { lineTokens: [], blockTokens: C_STYLE.blockTokens },
  scss: C_STYLE,
  less: C_STYLE,
  ini: { lineTokens: [';', '#'], blockTokens: [] },
  properties: { lineTokens: ['#', '!'], blockTokens: [] },
  bat: { lineTokens: ['REM ', '::'], blockTokens: [] },
};

const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.java': 'java', '.js': 'javascript', '.jsx': 'javascriptreact',
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.go': 'go', '.rs': 'rust', '.swift': 'swift',
  '.kt': 'kotlin', '.php': 'php', '.py': 'python', '.rb': 'ruby', '.sh': 'shellscript',
  '.ps1': 'powershell', '.lua': 'lua', '.sql': 'sql', '.html': 'html', '.htm': 'html',
  '.xml': 'xml', '.css': 'css', '.scss': 'scss', '.less': 'less', '.yml': 'yaml',
  '.yaml': 'yaml', '.ini': 'ini', '.properties': 'properties', '.bat': 'bat', '.cmd': 'bat',
  '.md': 'markdown', '.markdown': 'markdown',
};

export const TODO_SEARCH_GLOBS = [
  ...Object.keys(EXTENSION_LANGUAGE).map((extension) => `**/*${extension}`),
  '**/Dockerfile',
  '**/Makefile',
] as const;

export function getTodoCommentSyntax(languageId: string): TodoCommentSyntax | undefined {
  return LANGUAGE_SYNTAX[languageId];
}

export function inferTodoLanguageId(path: string): string | undefined {
  const fileName = path.replaceAll('\\', '/').split('/').pop()?.toLocaleLowerCase() ?? '';
  if (fileName === 'dockerfile') return 'dockerfile';
  if (fileName === 'makefile') return 'makefile';
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? undefined : EXTENSION_LANGUAGE[fileName.slice(dot)];
}

export function getTodoInsertionToken(languageId: string): { readonly open: string; readonly close: string } | undefined {
  const syntax = getTodoCommentSyntax(languageId);
  const line = syntax?.lineTokens[0];
  if (line !== undefined) return { open: line.trimEnd(), close: '' };
  const block = syntax?.blockTokens[0];
  return block === undefined ? undefined : { open: block.open, close: block.close };
}
