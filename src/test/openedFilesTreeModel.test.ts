import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildOpenedFilesTree, flattenOpenedFileTree, OpenedFileDescriptor } from '../tabManagement/openedFilesTreeModel';

function file(overrides: Partial<OpenedFileDescriptor> & Pick<OpenedFileDescriptor, 'id' | 'label'>): OpenedFileDescriptor {
  return {
    uri: `file:///workspace/${overrides.label}`,
    groupId: '1',
    groupLabel: '编辑器组 1',
    workspaceId: 'file:///workspace',
    workspaceLabel: 'workspace',
    pathSegments: [overrides.label],
    external: false,
    active: false,
    preview: false,
    ...overrides,
  };
}

describe('已打开文件目录树模型', () => {
  it('单编辑器组与单工作区不增加冗余根节点', () => {
    const roots = buildOpenedFilesTree([
      file({ id: 'a', label: 'app.ts', pathSegments: ['src', 'app.ts'] }),
      file({ id: 'b', label: 'util.ts', pathSegments: ['src', 'util.ts'] }),
    ]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.kind, 'directory');
    assert.equal(roots[0]?.label, 'src');
    assert.deepEqual(roots[0]?.children.map((node) => node.label), ['app.ts', 'util.ts']);
  });

  it('多编辑器组显示组根节点', () => {
    const roots = buildOpenedFilesTree([
      file({ id: 'a', label: 'a.ts' }),
      file({ id: 'b', label: 'b.ts', groupId: '2', groupLabel: '编辑器组 2' }),
    ]);
    assert.deepEqual(roots.map((node) => node.label), ['编辑器组 1', '编辑器组 2']);
    assert.ok(roots.every((node) => node.kind === 'group'));
  });

  it('多根工作区分开显示工作区节点', () => {
    const roots = buildOpenedFilesTree([
      file({ id: 'a', label: 'a.ts', workspaceId: 'file:///one', workspaceLabel: 'one' }),
      file({ id: 'b', label: 'b.ts', workspaceId: 'file:///two', workspaceLabel: 'two' }),
    ]);
    assert.deepEqual(roots.map((node) => node.label), ['one', 'two']);
    assert.ok(roots.every((node) => node.kind === 'workspace'));
  });

  it('工作区外文件统一位于尾部节点', () => {
    const roots = buildOpenedFilesTree([
      file({ id: 'inside', label: 'inside.ts' }),
      {
        id: 'outside',
        label: 'outside.ts',
        uri: 'file:///outside/outside.ts',
        groupId: '1',
        groupLabel: '编辑器组 1',
        pathSegments: ['outside.ts'],
        external: true,
        active: false,
        preview: false,
      },
    ]);
    assert.equal(roots.at(-1)?.kind, 'externalGroup');
    assert.equal(roots.at(-1)?.label, '工作区外文件');
    assert.equal(roots.at(-1)?.children[0]?.label, 'outside.ts');
  });

  it('扁平化结果包含所有目录与文件节点', () => {
    const roots = buildOpenedFilesTree([
      file({ id: 'a', label: 'a.ts', pathSegments: ['src', 'deep', 'a.ts'] }),
    ]);
    assert.deepEqual(flattenOpenedFileTree(roots).map((node) => node.label), ['src', 'deep', 'a.ts']);
  });
});
