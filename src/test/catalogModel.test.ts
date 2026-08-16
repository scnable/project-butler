import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  inferProjectType,
  isCatalogFileName,
  isPortableRelativePath,
  parseProjectCatalogText,
} from '../projectCatalog/catalogModel';
import { createCatalogTemplateText } from '../projectCatalog/catalogTemplate';

describe('项目集合模型', () => {
  it('识别项目集合文件名', () => {
    assert.equal(isCatalogFileName('demo.project-butler.json'), true);
    assert.equal(isCatalogFileName('DEMO.PROJECT-BUTLER.JSON'), true);
    assert.equal(isCatalogFileName('demo.json'), false);
  });

  it('只接受使用正斜杠的相对路径', () => {
    assert.equal(isPortableRelativePath('./frontend'), true);
    assert.equal(isPortableRelativePath('../server/app.code-workspace'), true);
    assert.equal(isPortableRelativePath('C:/projects/app'), false);
    assert.equal(isPortableRelativePath('https://example.invalid/app'), false);
    assert.equal(isPortableRelativePath('/projects/app'), false);
    assert.equal(isPortableRelativePath('..\\server'), false);
  });

  it('解析有效集合并推断工作区类型', () => {
    const catalog = parseProjectCatalogText(JSON.stringify({
      schemaVersion: 1,
      name: '测试集合',
      projects: [
        { alias: '前端', path: './frontend' },
        { alias: '后端', path: './server.code-workspace', tags: ['服务'] },
      ],
    }));
    assert.equal(catalog.issues.length, 0);
    assert.equal(catalog.projects.length, 2);
    assert.equal(inferProjectType(catalog.projects[1]?.path ?? '', catalog.projects[1]?.type ?? 'auto'), 'workspace');
  });

  it('保留无效条目并报告重复别名和绝对路径', () => {
    const catalog = parseProjectCatalogText(JSON.stringify({
      schemaVersion: 1,
      projects: [
        { alias: '应用', path: './app' },
        { alias: '应用', path: 'C:/app' },
        'invalid',
      ],
    }));
    assert.equal(catalog.projects.length, 3);
    assert.equal(catalog.projects[1]?.issues.length, 2);
    assert.equal(catalog.projects[2]?.alias, '无效项目 #3');
  });

  it('JSON 语法错误不会抛出异常', () => {
    const catalog = parseProjectCatalogText('{');
    assert.equal(catalog.projects.length, 0);
    assert.equal(catalog.issues[0]?.severity, 'error');
  });

  it('支持行注释和块注释，并保留字符串中的 URL', () => {
    const catalog = parseProjectCatalogText(`{
      // 集合格式版本
      "schemaVersion": 1,
      /* 项目列表 */
      "projects": [
        { "alias": "文档", "path": "https://example.invalid" }
      ]
    }`);
    assert.equal(catalog.projects.length, 1);
    assert.equal(catalog.projects[0]?.path, 'https://example.invalid');
  });

  it('创建的注释模板可以直接解析', () => {
    const template = createCatalogTemplateText();
    const catalog = parseProjectCatalogText(template);
    assert.equal(template.includes('// alias（必填）'), true);
    assert.equal(catalog.issues.length, 0);
    assert.equal(catalog.projects.length, 0);
    assert.equal(catalog.schemaVersion, 3);
    assert.equal(catalog.features.tabs.autoOrganize, false);
    assert.equal(catalog.features.symbolOutline.mode, 'both');
  });

  it('支持 JSONC 尾随逗号', () => {
    const catalog = parseProjectCatalogText(`{
      "schemaVersion": 1,
      "projects": [
        { "alias": "应用", "path": "./app", },
      ],
    }`);
    assert.equal(catalog.issues.length, 0);
    assert.equal(catalog.projects[0]?.alias, '应用');
  });

  it('兼容读取 v1 并提供标签默认值', () => {
    const catalog = parseProjectCatalogText('{ "schemaVersion": 1, "projects": [] }');
    assert.equal(catalog.compatibility, 'legacy');
    assert.deepEqual(catalog.features.tabs, { autoOrganize: false });
    assert.deepEqual(catalog.features.symbolOutline, { mode: 'both' });
    assert.equal(catalog.issues.length, 0);
  });

  it('兼容读取 v2 并将 auto 模式映射为自动整理开启', () => {
    const catalog = parseProjectCatalogText(JSON.stringify({
      schemaVersion: 2,
      features: {
        tabs: {
          groupingMode: 'auto',
        },
      },
      projects: [],
    }));
    assert.equal(catalog.compatibility, 'legacy');
    assert.equal(catalog.features.tabs.autoOrganize, true);
    assert.equal(catalog.features.symbolOutline.mode, 'both');
    assert.equal(catalog.issues.length, 0);
  });

  it('解析 v3 自动整理开关并对无效值安全降级', () => {
    const catalog = parseProjectCatalogText(JSON.stringify({
      schemaVersion: 3,
      features: { tabs: { autoOrganize: 'yes' } },
      projects: [],
    }));
    assert.equal(catalog.compatibility, 'current');
    assert.equal(catalog.features.tabs.autoOrganize, false);
    assert.equal(catalog.issues.some((issue) => issue.message.includes('autoOrganize')), true);
  });

  it('解析 v3 函数大纲模式并对无效值安全降级', () => {
    const valid = parseProjectCatalogText(JSON.stringify({
      schemaVersion: 3,
      features: { symbolOutline: { mode: 'enhanced' } },
      projects: [],
    }));
    assert.equal(valid.features.symbolOutline.mode, 'enhanced');
    assert.equal(valid.issues.length, 0);

    const invalid = parseProjectCatalogText(JSON.stringify({
      schemaVersion: 3,
      features: { symbolOutline: { mode: 'invalid' } },
      projects: [],
    }));
    assert.equal(invalid.features.symbolOutline.mode, 'both');
    assert.equal(invalid.issues.some((issue) => issue.message.includes('symbolOutline.mode')), true);
  });
});
