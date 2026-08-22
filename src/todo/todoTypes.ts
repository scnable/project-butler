export type TodoSeverity = 'info' | 'normal' | 'attention' | 'important';

export interface TodoTagDefinition {
  readonly name: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly severity: TodoSeverity;
  readonly icon: 'info' | 'check' | 'warning' | 'error';
}

export interface TodoMatch {
  readonly tag: string;
  readonly rawTag: string;
  readonly owner?: string;
  readonly text: string;
  readonly line: number;
  readonly startCharacter: number;
  readonly endCharacter: number;
  readonly completed: boolean;
  readonly source: 'comment' | 'markdownTask';
}

export interface TodoResourceResult {
  readonly uri: string;
  readonly workspaceUri?: string;
  readonly relativePath: string;
  readonly revision: number;
  readonly matches: readonly TodoMatch[];
}

export interface TodoParseOptions {
  readonly tags: readonly TodoTagDefinition[];
  readonly markdownTasks: boolean;
  readonly lineCommentTokens: readonly string[];
  readonly blockCommentTokens: readonly { readonly open: string; readonly close: string }[];
}

export type TodoScope = 'workspace' | 'currentFile';
export type TodoGrouping = 'file' | 'tag';
