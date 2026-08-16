export type OpenedFileNodeKind = 'group' | 'workspace' | 'directory' | 'externalGroup' | 'file';

export interface OpenedFileDescriptor {
  readonly id: string;
  readonly label: string;
  readonly uri: string;
  readonly groupId: string;
  readonly groupLabel: string;
  readonly workspaceId?: string;
  readonly workspaceLabel?: string;
  readonly pathSegments: readonly string[];
  readonly external: boolean;
  readonly active: boolean;
  readonly preview: boolean;
}

export interface OpenedFileTreeNode {
  readonly id: string;
  readonly kind: OpenedFileNodeKind;
  readonly label: string;
  readonly children: readonly OpenedFileTreeNode[];
  readonly uri?: string;
  readonly groupId?: string;
  readonly tabId?: string;
  readonly external?: boolean;
  readonly active?: boolean;
  readonly preview?: boolean;
}

interface MutableNode {
  readonly id: string;
  readonly kind: OpenedFileNodeKind;
  readonly label: string;
  readonly children: MutableNode[];
  uri?: string;
  groupId?: string;
  tabId?: string;
  external?: boolean;
  active?: boolean;
  preview?: boolean;
}

export function buildOpenedFilesTree(files: readonly OpenedFileDescriptor[]): OpenedFileTreeNode[] {
  const groupOrder = unique(files.map((file) => file.groupId));
  const multipleGroups = groupOrder.length > 1;
  const roots: MutableNode[] = [];

  for (const groupId of groupOrder) {
    const groupFiles = files.filter((file) => file.groupId === groupId);
    const groupChildren = buildGroupChildren(groupFiles, groupId);
    if (multipleGroups) {
      roots.push({
        id: `group:${groupId}`,
        kind: 'group',
        label: groupFiles[0]?.groupLabel ?? groupId,
        groupId,
        children: groupChildren,
      });
    } else {
      roots.push(...groupChildren);
    }
  }

  return roots;
}

export function flattenOpenedFileTree(nodes: readonly OpenedFileTreeNode[]): OpenedFileTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenOpenedFileTree(node.children)]);
}

function buildGroupChildren(files: readonly OpenedFileDescriptor[], groupId: string): MutableNode[] {
  const projectFiles = files.filter((file) => !file.external);
  const externalFiles = files.filter((file) => file.external);
  const workspaceOrder = unique(projectFiles.flatMap((file) => file.workspaceId === undefined ? [] : [file.workspaceId]));
  const multipleWorkspaces = workspaceOrder.length > 1;
  const children: MutableNode[] = [];

  for (const workspaceId of workspaceOrder) {
    const workspaceFiles = projectFiles.filter((file) => file.workspaceId === workspaceId);
    const workspaceChildren: MutableNode[] = [];
    for (const file of workspaceFiles) {
      insertFile(workspaceChildren, file, `group:${groupId}:workspace:${workspaceId}`);
    }
    if (multipleWorkspaces) {
      children.push({
        id: `group:${groupId}:workspace:${workspaceId}`,
        kind: 'workspace',
        label: workspaceFiles[0]?.workspaceLabel ?? workspaceId,
        groupId,
        children: workspaceChildren,
      });
    } else {
      children.push(...workspaceChildren);
    }
  }

  if (externalFiles.length > 0) {
    const externalChildren: MutableNode[] = [];
    for (const file of externalFiles) {
      insertFile(externalChildren, file, `group:${groupId}:external`);
    }
    children.push({
      id: `group:${groupId}:external`,
      kind: 'externalGroup',
      label: '工作区外文件',
      groupId,
      children: externalChildren,
    });
  }

  return children;
}

function insertFile(
  roots: MutableNode[],
  file: OpenedFileDescriptor,
  parentId: string,
): void {
  let current = roots;
  let currentId = parentId;
  for (const segment of file.pathSegments.slice(0, -1)) {
    const nextId = `${currentId}/dir:${encodeURIComponent(segment)}`;
    let directory = current.find((node) => node.id === nextId);
    if (directory === undefined) {
      directory = {
        id: nextId,
        kind: 'directory',
        label: segment,
        groupId: file.groupId,
        children: [],
      };
      current.push(directory);
    }
    current = directory.children;
    currentId = nextId;
  }
  current.push({
    id: `file:${file.id}`,
    kind: 'file',
    label: file.label,
    uri: file.uri,
    groupId: file.groupId,
    tabId: file.id,
    external: file.external,
    active: file.active,
    preview: file.preview,
    children: [],
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
