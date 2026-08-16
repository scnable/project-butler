import type { ResourceKind } from './exclusionPatterns';

export interface HierarchicalResource<T> {
  readonly relativePath: string;
  readonly kind: ResourceKind;
  readonly value: T;
}

export function stripRecursiveSuffix(pattern: string): string {
  return pattern.replace(/\\/g, '/').replace(/\/\*\*$/, '').replace(/\/+$/, '');
}

export function isDescendantPattern(candidate: string, parent: string): boolean {
  const candidatePath = stripRecursiveSuffix(candidate);
  const parentPath = stripRecursiveSuffix(parent);
  return candidatePath !== parentPath && candidatePath.startsWith(`${parentPath}/`);
}

export function consolidateHierarchicalResources<T>(
  resources: readonly HierarchicalResource<T>[],
): readonly HierarchicalResource<T>[] {
  const sorted = [...resources].sort((left, right) => {
    const depthDifference = pathDepth(left.relativePath) - pathDepth(right.relativePath);
    return depthDifference !== 0
      ? depthDifference
      : left.relativePath.localeCompare(right.relativePath);
  });
  const result: HierarchicalResource<T>[] = [];

  for (const resource of sorted) {
    const covered = result.some(
      (existing) => existing.relativePath === resource.relativePath
        || (
          existing.kind === 'directory'
          && isDescendantPattern(resource.relativePath, existing.relativePath)
        ),
    );
    if (!covered) {
      result.push(resource);
    }
  }

  return result;
}

function pathDepth(relativePath: string): number {
  return stripRecursiveSuffix(relativePath).split('/').length;
}
