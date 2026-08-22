export interface TodoPathResource {
  readonly relativePath: string;
}

export interface TodoHierarchyDirectory<T extends TodoPathResource> {
  readonly label: string;
  readonly path: string;
  readonly resources: readonly T[];
}

export interface TodoHierarchy<T extends TodoPathResource> {
  readonly directories: readonly TodoHierarchyDirectory<T>[];
  readonly files: readonly T[];
}

export function buildTodoHierarchy<T extends TodoPathResource>(
  resources: readonly T[],
  parentPath = '',
): TodoHierarchy<T> {
  const directories = new Map<string, T[]>();
  const files: T[] = [];
  const prefix = parentPath.length === 0 ? '' : `${parentPath}/`;

  for (const resource of resources) {
    const remaining = resource.relativePath.startsWith(prefix)
      ? resource.relativePath.slice(prefix.length)
      : resource.relativePath;
    const separator = remaining.indexOf('/');
    if (separator < 0) {
      files.push(resource);
      continue;
    }
    const segment = remaining.slice(0, separator);
    const entries = directories.get(segment) ?? [];
    entries.push(resource);
    directories.set(segment, entries);
  }

  return {
    directories: [...directories.entries()]
      .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
      .map(([segment, entries]) => compactDirectory(prefix, segment, entries)),
    files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, undefined, { numeric: true })),
  };
}

function compactDirectory<T extends TodoPathResource>(
  prefix: string,
  firstSegment: string,
  resources: readonly T[],
): TodoHierarchyDirectory<T> {
  const segments = [firstSegment];
  let path = `${prefix}${firstSegment}`;

  while (true) {
    const childPrefix = `${path}/`;
    const nextSegments = new Set<string>();
    let canCompact = true;
    for (const resource of resources) {
      const remaining = resource.relativePath.startsWith(childPrefix)
        ? resource.relativePath.slice(childPrefix.length)
        : '';
      const separator = remaining.indexOf('/');
      if (separator < 0) {
        canCompact = false;
        break;
      }
      nextSegments.add(remaining.slice(0, separator));
      if (nextSegments.size > 1) {
        canCompact = false;
        break;
      }
    }
    if (!canCompact || nextSegments.size !== 1) break;
    const next = [...nextSegments][0];
    if (next === undefined || next.length === 0) break;
    segments.push(next);
    path = `${path}/${next}`;
  }

  return { label: `${segments.join('/')}/`, path, resources };
}
