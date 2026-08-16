import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseProjectCatalogText } from '../projectCatalog/catalogModel';
import {
  CatalogProjectInsertion,
  createCatalogProjectInsertion,
  createCatalogSymbolOutlineSettingsEdits,
  createCatalogTabSettingsEdits,
  NewCatalogProject,
} from '../projectCatalog/catalogTextEdit';

const project: NewCatalogProject = {
  alias: '管理后台',
  path: './admin-web',
  type: 'folder',
  description: '前端项目',
  tags: ['前端'],
};

describe('项目集合文本追加', () => {
  it('向只有注释的空数组追加项目并保留注释', () => {
    const source = `{
  "schemaVersion": 1,
  "projects": [
    // 使用按钮添加项目
  ]
}
`;
    const result = applyInsertion(source, createCatalogProjectInsertion(source, project));
    const catalog = parseProjectCatalogText(result);
    assert.equal(result.includes('// 使用按钮添加项目'), true);
    assert.equal(catalog.issues.length, 0);
    assert.equal(catalog.projects[0]?.alias, '管理后台');
  });

  it('向现有项目后追加逗号和新项目，并保留尾部注释', () => {
    const source = `{
  "schemaVersion": 1,
  "projects": [
    { "alias": "服务端", "path": "./server" } // 保留说明
  ]
}`;
    const result = applyInsertion(source, createCatalogProjectInsertion(source, project));
    const catalog = parseProjectCatalogText(result);
    assert.equal(result.includes('// 保留说明'), true);
    assert.equal(catalog.issues.length, 0);
    assert.deepEqual(catalog.projects.map((item) => item.alias), ['服务端', '管理后台']);
  });

  it('兼容已经存在尾随逗号的项目数组', () => {
    const source = `{
  "schemaVersion": 1,
  "projects": [
    { "alias": "服务端", "path": "./server" },
  ]
}`;
    const result = applyInsertion(source, createCatalogProjectInsertion(source, project));
    const catalog = parseProjectCatalogText(result);
    assert.equal(catalog.issues.length, 0);
    assert.equal(catalog.projects.length, 2);
  });

  it('为 v1 集合插入简化标签配置并升级到 v3', () => {
    const source = `{
  // 保留集合名称说明
  "schemaVersion": 1,
  "name": "测试集合",
  "projects": []
}`;
    const result = applyTextReplacements(source, createCatalogTabSettingsEdits(source, {
      autoOrganize: true,
    }));
    const catalog = parseProjectCatalogText(result);
    assert.equal(result.includes('// 保留集合名称说明'), true);
    assert.equal(result.includes('\n  "features"'), true);
    assert.equal(result.includes('\n  "projects"'), true);
    assert.equal(catalog.schemaVersion, 3);
    assert.equal(catalog.features.tabs.autoOrganize, true);
  });

  it('升级 v2 tabs 时移除旧参数并保留 features 中的其他配置和外部注释', () => {
    const source = `{
  "schemaVersion": 2,
  "features": {
    // 标签设置由集合共享
    "tabs": {
      "groupingMode": "prompt",
      "minimumTabs": 8
    },
    "futureFeature": { "enabled": true }
  },
  "projects": []
}`;
    const result = applyTextReplacements(source, createCatalogTabSettingsEdits(source, {
      autoOrganize: false,
    }));
    const catalog = parseProjectCatalogText(result);
    assert.equal(result.includes('// 标签设置由集合共享'), true);
    assert.equal(result.includes('"futureFeature"'), true);
    assert.equal(catalog.schemaVersion, 3);
    assert.equal(catalog.features.tabs.autoOrganize, false);
    assert.equal(result.includes('"minimumTabs"'), false);
  });

  it('更新 v3 开关时保留 tabs 内部注释', () => {
    const source = `{
  "schemaVersion": 3,
  "features": {
    "tabs": {
      // 用户说明
      "autoOrganize": false
    }
  },
  "projects": []
}`;
    const result = applyTextReplacements(source, createCatalogTabSettingsEdits(source, { autoOrganize: true }));
    const catalog = parseProjectCatalogText(result);
    assert.equal(result.includes('// 用户说明'), true);
    assert.equal(catalog.features.tabs.autoOrganize, true);
  });

  it('更新 v3 函数大纲模式并保留原有标签配置', () => {
    const source = `{
  "schemaVersion": 3,
  "features": {
    "tabs": { "autoOrganize": true },
    "symbolOutline": {
      // 团队共享的大纲模式
      "mode": "both"
    }
  },
  "projects": []
}`;
    const result = applyTextReplacements(
      source,
      createCatalogSymbolOutlineSettingsEdits(source, { mode: 'enhanced' }),
    );
    const catalog = parseProjectCatalogText(result);
    assert.equal(result.includes('// 团队共享的大纲模式'), true);
    assert.equal(catalog.features.tabs.autoOrganize, true);
    assert.equal(catalog.features.symbolOutline.mode, 'enhanced');
  });

  it('为旧集合插入函数大纲配置并升级到 v3', () => {
    const source = `{
  "schemaVersion": 2,
  "features": {
    "tabs": { "groupingMode": "auto" }
  },
  "projects": []
}`;
    const result = applyTextReplacements(
      source,
      createCatalogSymbolOutlineSettingsEdits(source, { mode: 'native' }),
    );
    const catalog = parseProjectCatalogText(result);
    assert.equal(catalog.schemaVersion, 3);
    assert.equal(catalog.features.symbolOutline.mode, 'native');
    assert.equal(catalog.features.tabs.autoOrganize, true);
    assert.equal(catalog.issues.length, 0);
  });
});

function applyInsertion(source: string, insertion: CatalogProjectInsertion): string {
  const edits = [
    { offset: insertion.entryOffset, text: insertion.entryText },
    ...(insertion.commaOffset === undefined
      ? []
      : [{ offset: insertion.commaOffset, text: ',' }]),
  ].sort((left, right) => right.offset - left.offset);
  return edits.reduce(
    (value, edit) => `${value.slice(0, edit.offset)}${edit.text}${value.slice(edit.offset)}`,
    source,
  );
}

function applyTextReplacements(
  source: string,
  edits: readonly { start: number; end: number; text: string }[],
): string {
  return [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (value, edit) => `${value.slice(0, edit.start)}${edit.text}${value.slice(edit.end)}`,
      source,
    );
}
