import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildExclusionPatterns,
  buildFileTypeExclusionPattern,
  escapeGlobPath,
  normalizeRelativePath,
} from '../exclusions/exclusionPatterns';

describe('normalizeRelativePath', () => {
  it('统一 Windows 分隔符并移除首尾冗余', () => {
    assert.equal(normalizeRelativePath('.\\src\\generated\\'), 'src/generated');
  });

  it('拒绝工作区外路径', () => {
    assert.throws(() => normalizeRelativePath('../secret.txt'), /无效的工作区相对路径/);
  });
});

describe('escapeGlobPath', () => {
  it('转义路径中的 Glob 特殊字符', () => {
    assert.equal(
      escapeGlobPath('src/[draft]/{demo}?.ts'),
      'src/[[]draft[]]/[{]demo[}][?].ts',
    );
  });

  it('保留中文和空格', () => {
    assert.equal(escapeGlobPath('生成 文件/结果.txt'), '生成 文件/结果.txt');
  });
});

describe('buildExclusionPatterns', () => {
  it('目录为搜索和监控生成递归规则', () => {
    assert.deepEqual(buildExclusionPatterns('dist', 'directory'), {
      explorer: 'dist',
      search: 'dist/**',
      watcher: 'dist/**',
    });
  });

  it('文件在三个设置中使用相同规则', () => {
    assert.deepEqual(buildExclusionPatterns('logs/app.log', 'file'), {
      explorer: 'logs/app.log',
      search: 'logs/app.log',
      watcher: 'logs/app.log',
    });
  });
});

describe('buildFileTypeExclusionPattern', () => {
  it('为扩展名生成整个工作区范围的 Glob', () => {
    assert.equal(buildFileTypeExclusionPattern('.log'), '**/*.log');
    assert.equal(buildFileTypeExclusionPattern('.ts'), '**/*.ts');
  });

  it('拒绝空扩展名和路径', () => {
    assert.throws(() => buildFileTypeExclusionPattern(''), /无效/u);
    assert.throws(() => buildFileTypeExclusionPattern('.a/b'), /无效/u);
  });
});
