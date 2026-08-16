import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  chooseCatalogToRestore,
  shouldAutoActivateCatalog,
} from '../projectCatalog/catalogActivation';

describe('项目集合激活状态', () => {
  it('已有活动集合时不会被另一个集合文件自动替换', () => {
    assert.equal(shouldAutoActivateCatalog('file:///a.project-butler.json', 'file:///b.project-butler.json', undefined), false);
    assert.equal(shouldAutoActivateCatalog('file:///a.project-butler.json', 'file:///a.project-butler.json', undefined), true);
  });

  it('没有活动集合时允许直接打开集合文件激活', () => {
    assert.equal(shouldAutoActivateCatalog(undefined, 'file:///a.project-butler.json', undefined), true);
    assert.equal(shouldAutoActivateCatalog(undefined, 'file:///a.project-butler.json', 'file:///a.project-butler.json'), false);
  });

  it('启动恢复优先使用已经保存的集合而不是任意打开文档', () => {
    assert.equal(chooseCatalogToRestore(
      'file:///saved.json',
      'file:///last.json',
      true,
      'file:///active.json',
      ['file:///other.json'],
    ), 'file:///saved.json');
    assert.equal(chooseCatalogToRestore(
      undefined,
      undefined,
      true,
      'file:///active.json',
      ['file:///other.json'],
    ), 'file:///active.json');
  });

  it('普通未关联工作区不会恢复全局最后集合', () => {
    assert.equal(chooseCatalogToRestore(
      undefined,
      'file:///last.json',
      true,
      undefined,
      [],
    ), undefined);
  });

  it('无工作区的集合启动窗口可以恢复全局最后集合', () => {
    assert.equal(chooseCatalogToRestore(
      undefined,
      'file:///last.json',
      false,
      undefined,
      [],
    ), 'file:///last.json');
  });
});
