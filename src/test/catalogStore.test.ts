import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  appendCatalog,
  chooseStoredCatalogToRestore,
  createEmptyCatalogLibrary,
  createStoredCatalog,
  createStoredProject,
  loadCatalogLibrary,
  replaceCatalog,
  withRenamedCatalog,
  withRenamedProject,
  withUpdatedCatalog,
  withUpdatedProjectResource,
  withoutStoredProject,
} from '../projectCatalog/catalogStore';

describe('内部项目集合存储', () => {
  it('创建集合时生成稳定标识并默认跟随个人设置', () => {
    const catalog = createStoredCatalog('  日常项目  ');
    assert.equal(catalog.name, '日常项目');
    assert.equal(catalog.id.length > 0, true);
    assert.deepEqual(catalog.features.tabs, {});
    assert.deepEqual(catalog.features.symbolOutline, {});
  });

  it('规范化项目别名、说明和标签', () => {
    const project = createStoredProject({
      alias: '  前端  ',
      uri: 'file:///workspace/frontend',
      type: 'folder',
      description: '  管理端  ',
      tags: [' 前端 ', '日常', '前端', ''],
    });
    assert.equal(project.alias, '前端');
    assert.equal(project.description, '管理端');
    assert.deepEqual(project.tags, ['前端', '日常']);
  });

  it('局部无效功能字段按字段改为跟随个人设置', () => {
    const result = loadCatalogLibrary({
      storageVersion: 1,
      catalogs: [{
        id: 'catalog-1',
        name: '集合',
        features: {
          tabs: { autoOrganize: true },
          symbolOutline: { mode: 'invalid' },
        },
        projects: [],
        createdAt: '2026-08-13T00:00:00.000Z',
        updatedAt: '2026-08-13T00:00:00.000Z',
      }],
    });
    assert.equal(result.library.catalogs[0]?.features.tabs.autoOrganize, true);
    assert.equal(result.library.catalogs[0]?.features.symbolOutline.mode, undefined);
    assert.equal(result.issues.some((issue) => issue.includes('函数大纲配置')), true);
  });

  it('新增和更新集合时不改变其他集合', () => {
    const first = createStoredCatalog('第一组');
    const second = createStoredCatalog('第二组');
    const library = appendCatalog(appendCatalog(createEmptyCatalogLibrary(), first), second);
    const updated = withUpdatedCatalog(first, { features: { ...first.features, tabs: { autoOrganize: true } } });
    const next = replaceCatalog(library, updated);
    assert.equal(next.catalogs[0]?.features.tabs.autoOrganize, true);
    assert.equal(next.catalogs[1]?.id, second.id);
  });

  it('不支持的内部存储版本回退为空集合并给出问题', () => {
    const result = loadCatalogLibrary({ storageVersion: 99, catalogs: [] });
    assert.equal(result.library.catalogs.length, 0);
    assert.equal(result.issues.length, 1);
  });

  it('恢复集合时遵循绑定、窗口、唯一匹配和最近选择顺序', () => {
    assert.equal(chooseStoredCatalogToRestore(
      ['bound', 'workspace', 'matched', 'last'],
      false,
      ['bound', 'workspace', 'matched', 'last'],
    ), 'bound');
    assert.equal(chooseStoredCatalogToRestore(['workspace'], false, ['missing', 'workspace']), 'workspace');
  });

  it('用户退出集合后禁止本窗口自动恢复', () => {
    assert.equal(chooseStoredCatalogToRestore(['bound'], true, ['bound']), undefined);
  });

  it('重命名集合时保留稳定标识、项目和功能配置', () => {
    const catalog = createStoredCatalog('旧名称', [{ alias: '项目', uri: 'file:///project', type: 'folder' }]);
    const renamed = withRenamedCatalog(catalog, '  新名称  ');
    assert.equal(renamed.name, '新名称');
    assert.equal(renamed.id, catalog.id);
    assert.equal(renamed.projects[0]?.id, catalog.projects[0]?.id);
    assert.deepEqual(renamed.features, catalog.features);
  });

  it('重命名项目别名时只修改目标项目并保留元数据', () => {
    const catalog = createStoredCatalog('集合', [
      { alias: '前端', uri: 'file:///frontend', type: 'folder', description: '说明', tags: ['A'] },
      { alias: '后端', uri: 'file:///backend', type: 'folder' },
    ]);
    const project = catalog.projects[0]!;
    const renamed = withRenamedProject(catalog, project.id, '  管理端  ');
    assert.equal(renamed.projects[0]?.alias, '管理端');
    assert.equal(renamed.projects[0]?.id, project.id);
    assert.equal(renamed.projects[0]?.uri, project.uri);
    assert.equal(renamed.projects[0]?.description, '说明');
    assert.deepEqual(renamed.projects[0]?.tags, ['A']);
    assert.equal(renamed.projects[1], catalog.projects[1]);
  });

  it('重新选择项目资源时保留身份和说明标签', () => {
    const catalog = createStoredCatalog('集合', [{
      alias: '应用', uri: 'file:///old', type: 'folder', description: '说明', tags: ['核心'],
    }]);
    const project = catalog.projects[0]!;
    const updated = withUpdatedProjectResource(catalog, project.id, 'file:///new.code-workspace', 'workspace');
    assert.deepEqual(updated.projects[0], {
      ...project,
      uri: 'file:///new.code-workspace',
      type: 'workspace',
    });
  });

  it('从集合移出项目时只移除目标稳定标识', () => {
    const catalog = createStoredCatalog('集合', [
      { alias: '前端', uri: 'file:///frontend', type: 'folder' },
      { alias: '后端', uri: 'file:///backend', type: 'folder' },
    ]);
    const removed = withoutStoredProject(catalog, catalog.projects[0]!.id);
    assert.deepEqual(removed.projects.map((project) => project.alias), ['后端']);
    assert.equal(removed.id, catalog.id);
    assert.deepEqual(removed.features, catalog.features);
  });
});
