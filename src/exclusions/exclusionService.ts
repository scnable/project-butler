import * as vscode from 'vscode';
import { buildExclusionPatterns, type ResourceKind } from './exclusionPatterns';
import { getWorkspaceRelativePath } from '../shared/uri';

type ExcludeSettingValue = boolean | { readonly when: string };
type ExcludeSetting = Readonly<Record<string, ExcludeSettingValue>>;

interface SettingTarget {
  readonly section: 'files' | 'search';
  readonly key: 'exclude' | 'watcherExclude';
  readonly label: string;
  readonly patternType: 'explorer' | 'search' | 'watcher';
}

interface FolderPlan {
  readonly folder: vscode.WorkspaceFolder;
  readonly resources: Set<string>;
  readonly patterns: Map<SettingTarget, Set<string>>;
}

interface AppliedSetting {
  readonly configuration: vscode.WorkspaceConfiguration;
  readonly key: string;
  readonly before: ExcludeSetting | undefined;
}

export interface ExclusionResult {
  readonly resourceCount: number;
  readonly settingEntryCount: number;
  readonly skippedCount: number;
}

const SETTING_TARGETS: readonly SettingTarget[] = [
  {
    section: 'files',
    key: 'exclude',
    label: '目录展示',
    patternType: 'explorer',
  },
  {
    section: 'search',
    key: 'exclude',
    label: '搜索',
    patternType: 'search',
  },
  {
    section: 'files',
    key: 'watcherExclude',
    label: '文件监控',
    patternType: 'watcher',
  },
];

export class ExclusionService {
  public constructor(private readonly output: vscode.OutputChannel) {}

  public async exclude(resources: readonly vscode.Uri[]): Promise<ExclusionResult> {
    const { plans, skippedCount } = await this.createPlans(resources);
    const resourceCount = [...plans.values()].reduce(
      (total, plan) => total + plan.resources.size,
      0,
    );

    if (resourceCount === 0) {
      return { resourceCount: 0, settingEntryCount: 0, skippedCount };
    }

    const confirmed = await this.confirm(resourceCount);
    if (!confirmed) {
      return { resourceCount: 0, settingEntryCount: 0, skippedCount };
    }

    const appliedSettings: AppliedSetting[] = [];
    let settingEntryCount = 0;

    try {
      for (const plan of plans.values()) {
        for (const [target, patterns] of plan.patterns) {
          const configuration = vscode.workspace.getConfiguration(target.section, plan.folder.uri);
          const inspection = configuration.inspect<ExcludeSetting>(target.key);
          const before = inspection?.workspaceFolderValue;
          const next: Record<string, ExcludeSettingValue> = { ...(before ?? {}) };
          let changed = false;

          for (const pattern of patterns) {
            if (next[pattern] !== true) {
              next[pattern] = true;
              changed = true;
              settingEntryCount += 1;
            }
          }

          if (!changed) {
            continue;
          }

          await configuration.update(
            target.key,
            next,
            vscode.ConfigurationTarget.WorkspaceFolder,
          );
          appliedSettings.push({ configuration, key: target.key, before });
          this.output.appendLine(
            `[屏蔽] ${plan.folder.name} / ${target.label}: ${[...patterns].join(', ')}`,
          );
        }
      }
    } catch (error) {
      await this.rollback(appliedSettings);
      throw error;
    }

    return { resourceCount, settingEntryCount, skippedCount };
  }

  private async createPlans(resources: readonly vscode.Uri[]): Promise<{
    readonly plans: Map<string, FolderPlan>;
    readonly skippedCount: number;
  }> {
    const plans = new Map<string, FolderPlan>();
    let skippedCount = 0;

    for (const resource of resources) {
      const folder = vscode.workspace.getWorkspaceFolder(resource);
      if (folder === undefined) {
        skippedCount += 1;
        this.output.appendLine(`[跳过] 资源不属于当前工作区: ${resource.toString(true)}`);
        continue;
      }

      const relativePath = getWorkspaceRelativePath(folder, resource);
      if (relativePath === undefined) {
        skippedCount += 1;
        this.output.appendLine(`[跳过] 不支持屏蔽工作区根目录: ${resource.toString(true)}`);
        continue;
      }

      let kind: ResourceKind;
      try {
        const stat = await vscode.workspace.fs.stat(resource);
        kind = (stat.type & vscode.FileType.Directory) !== 0 ? 'directory' : 'file';
      } catch (error) {
        skippedCount += 1;
        this.output.appendLine(
          `[跳过] 无法读取资源类型: ${resource.toString(true)}；${formatError(error)}`,
        );
        continue;
      }

      const folderKey = folder.uri.toString();
      let plan = plans.get(folderKey);
      if (plan === undefined) {
        plan = {
          folder,
          resources: new Set<string>(),
          patterns: new Map<SettingTarget, Set<string>>(),
        };
        plans.set(folderKey, plan);
      }

      plan.resources.add(resource.toString());
      const patterns = buildExclusionPatterns(relativePath, kind);

      for (const target of SETTING_TARGETS) {
        let targetPatterns = plan.patterns.get(target);
        if (targetPatterns === undefined) {
          targetPatterns = new Set<string>();
          plan.patterns.set(target, targetPatterns);
        }
        targetPatterns.add(patterns[target.patternType]);
      }
    }

    return { plans, skippedCount };
  }

  private async confirm(resourceCount: number): Promise<boolean> {
    const shouldConfirm = vscode.workspace
      .getConfiguration('projectManager.exclusions')
      .get<boolean>('confirmBeforeApply', true);

    if (!shouldConfirm) {
      return true;
    }

    const choice = await vscode.window.showWarningMessage(
      `将屏蔽 ${resourceCount} 个资源，使其不再出现在目录、搜索结果和文件监控中。`,
      { modal: true },
      '继续屏蔽',
    );
    return choice === '继续屏蔽';
  }

  private async rollback(appliedSettings: readonly AppliedSetting[]): Promise<void> {
    for (const applied of [...appliedSettings].reverse()) {
      try {
        await applied.configuration.update(
          applied.key,
          applied.before,
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
      } catch (rollbackError) {
        this.output.appendLine(`[回滚失败] ${applied.key}: ${formatError(rollbackError)}`);
      }
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
