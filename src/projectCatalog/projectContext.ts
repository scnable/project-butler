export interface ProjectContextCandidate {
  readonly projectIndex: number;
  readonly key: string;
}

export type ProjectContextClassification =
  | { readonly kind: 'member'; readonly projectIndex: number }
  | { readonly kind: 'external' }
  | { readonly kind: 'noWorkspace' };

export function classifyProjectContext(
  hasWorkspace: boolean,
  currentProjectKey: string | undefined,
  candidates: readonly ProjectContextCandidate[],
): ProjectContextClassification {
  if (!hasWorkspace) {
    return { kind: 'noWorkspace' };
  }
  if (currentProjectKey !== undefined) {
    const matched = candidates.find((candidate) => candidate.key === currentProjectKey);
    if (matched !== undefined) {
      return { kind: 'member', projectIndex: matched.projectIndex };
    }
  }
  return { kind: 'external' };
}
