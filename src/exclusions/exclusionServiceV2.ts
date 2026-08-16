import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildExclusionPatterns, buildFileTypeExclusionPattern, type ExclusionPatternSet, type ResourceKind } from './exclusionPatterns';
import {
  consolidateHierarchicalResources,
  isDescendantPattern,
  stripRecursiveSuffix,
} from './exclusionHierarchy';
import { getWorkspaceRelativePath } from '../shared/uri';

type ExcludeSettingValue = boolean | { readonly when: string };
type ExcludeSetting = Readonly<Record<string, ExcludeSettingValue>>;
type MutableExcludeSetting = Record<string, ExcludeSettingValue>;
type TargetId = 'explorer' | 'search' | 'watcher';

interface SettingTarget {
  readonly id: TargetId;
  readonly section: 'files' | 'search';
  readonly key: 'exclude' | 'watcherExclude';
  readonly label: string;
}

interface PlannedResource {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly kind: ResourceKind;
  readonly patterns: ExclusionPatternSet;
}

interface FolderPlan {
  readonly folder: vscode.WorkspaceFolder;
  readonly resources: PlannedResource[];
}

interface SettingState {
  readonly target: SettingTarget;
  readonly configuration: vscode.WorkspaceConfiguration;
  readonly before: ExcludeSetting | undefined;
  readonly next: MutableExcludeSetting;
}

interface AppliedSetting {
  readonly configuration: vscode.WorkspaceConfiguration;
  readonly key: string;
  readonly before: ExcludeSetting | undefined;
}

interface CoveredSettingEntry {
  readonly targetId: TargetId;
  readonly pattern: string;
  readonly value: ExcludeSettingValue;
}

interface ConsolidationSnapshot {
  readonly folderUri: string;
  readonly parentPattern: string;
  readonly entries: readonly CoveredSettingEntry[];
}

export interface ActiveExclusion {
  readonly id: string;
  readonly folderUri: string;
  readonly folderName: string;
  readonly pattern: string;
  readonly recursive: boolean;
  readonly targets: readonly string[];
}

export interface ExclusionResult {
  readonly resourceCount: number;
  readonly settingEntryCount: number;
  readonly skippedCount: number;
  readonly redundantRuleCount: number;
}

export interface RestoreResult {
  readonly restoredCount: number;
  readonly restoredCoveredRuleCount: number;
}

export interface FileTypeExclusionResult {
  readonly typeCount: number;
  readonly settingEntryCount: number;
  readonly skippedCount: number;
  readonly patterns: readonly string[];
}

const SNAPSHOT_KEY = 'projectManager.exclusionConsolidationSnapshots.v1';

const SETTING_TARGETS: readonly SettingTarget[] = [
  { id: 'explorer', section: 'files', key: 'exclude', label: '目录展示' },
  { id: 'search', section: 'search', key: 'exclude', label: '搜索' },
  { id: 'watcher', section: 'files', key: 'watcherExclude', label: '文件监控' },
];

export class ExclusionServiceV2 {
  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly workspaceState: vscode.Memento,
    private readonly getConfiguration: (
      section: string,
      scope?: vscode.ConfigurationScope | null,
    ) => vscode.WorkspaceConfiguration = (section, scope) => vscode.workspace.getConfiguration(section, scope),
  ) {}

  public async exclude(resources: readonly vscode.Uri[]): Promise<ExclusionResult> {
    const prepared = await this.createPlans(resources);
    const filtered = await this.filterCoveredResources(prepared.plans);
    const resourceCount = [...filtered.plans.values()].reduce(
      (total, plan) => total + plan.resources.length,
      0,
    );
    const skippedCount = prepared.skippedCount + filtered.coveredCount;

    if (resourceCount === 0) {
      return {
        resourceCount: 0,
        settingEntryCount: 0,
        skippedCount,
        redundantRuleCount: 0,
      };
    }

    if (!await this.confirmExclude(resourceCount)) {
      return {
        resourceCount: 0,
        settingEntryCount: 0,
        skippedCount,
        redundantRuleCount: 0,
      };
    }

    const appliedSettings: AppliedSetting[] = [];
    const newSnapshots: ConsolidationSnapshot[] = [];
    let settingEntryCount = 0;
    let redundantRuleCount = 0;

    try {
      for (const plan of filtered.plans.values()) {
        const states = this.createSettingStates(plan.folder);

        for (const resource of plan.resources) {
          if (resource.kind === 'directory') {
            const removedEntries: CoveredSettingEntry[] = [];
            for (const state of states) {
              const parentPattern = resource.patterns[state.target.id];
              for (const [existingPattern, existingValue] of Object.entries(state.next)) {
                if (isDescendantPattern(existingPattern, parentPattern)) {
                  removedEntries.push({
                    targetId: state.target.id,
                    pattern: existingPattern,
                    value: existingValue,
                  });
                  delete state.next[existingPattern];
                  redundantRuleCount += 1;
                }
              }
            }

            if (removedEntries.length > 0) {
              newSnapshots.push({
                folderUri: plan.folder.uri.toString(),
                parentPattern: resource.patterns.explorer,
                entries: removedEntries,
              });
            }
          }

          for (const state of states) {
            const pattern = resource.patterns[state.target.id];
            if (state.next[pattern] !== true) {
              state.next[pattern] = true;
              settingEntryCount += 1;
            }
          }
        }

        for (const state of states) {
          if (settingsEqual(state.before, state.next)) {
            continue;
          }
          await state.configuration.update(
            state.target.key,
            state.next,
            vscode.ConfigurationTarget.WorkspaceFolder,
          );
          appliedSettings.push({
            configuration: state.configuration,
            key: state.target.key,
            before: state.before,
          });
          this.output.appendLine(
            `[屏蔽] ${plan.folder.name} / ${state.target.label}: ${Object.keys(state.next).join(', ')}`,
          );
        }
      }
    } catch (error) {
      await this.rollback(appliedSettings);
      throw error;
    }

    if (newSnapshots.length > 0) {
      await this.mergeSnapshots(newSnapshots);
    }

    return { resourceCount, settingEntryCount, skippedCount, redundantRuleCount };
  }

  public async excludeFileTypes(resources: readonly vscode.Uri[]): Promise<FileTypeExclusionResult> {
    const patternsByFolder = new Map<string, { folder: vscode.WorkspaceFolder; patterns: Set<string> }>();
    let skippedCount = 0;
    for (const uri of resources) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder === undefined) {
        skippedCount += 1;
        this.output.appendLine(`[跳过] 资源不属于当前工作区: ${uri.toString(true)}`);
        continue;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) {
          skippedCount += 1;
          this.output.appendLine(`[跳过] 文件夹没有文件扩展名: ${uri.toString(true)}`);
          continue;
        }
      } catch (error) {
        skippedCount += 1;
        this.output.appendLine(`[跳过] 无法读取资源类型: ${uri.toString(true)}；${formatError(error)}`);
        continue;
      }
      const extension = path.posix.extname(uri.path);
      if (extension.length < 2) {
        skippedCount += 1;
        this.output.appendLine(`[跳过] 文件没有可识别的扩展名: ${uri.toString(true)}`);
        continue;
      }
      const pattern = buildFileTypeExclusionPattern(extension);
      const key = folder.uri.toString();
      const existing = patternsByFolder.get(key);
      if (existing === undefined) {
        patternsByFolder.set(key, { folder, patterns: new Set([pattern]) });
      } else {
        existing.patterns.add(pattern);
      }
    }

    const allPatterns = [...new Set([...patternsByFolder.values()].flatMap((item) => [...item.patterns]))];
    if (allPatterns.length === 0) {
      return { typeCount: 0, settingEntryCount: 0, skippedCount, patterns: [] };
    }
    const shouldConfirm = vscode.workspace
      .getConfiguration('projectManager.exclusions')
      .get<boolean>('confirmBeforeApply', true);
    if (shouldConfirm) {
      const choice = await vscode.window.showWarningMessage(
        `将在所选文件所属工作区中屏蔽以下文件类型：${allPatterns.join('、')}。目录、搜索结果和文件监控都会受到影响；C/C++ 等语言扩展可能不再为被屏蔽文件提供大纲符号。`,
        { modal: true },
        '继续屏蔽',
      );
      if (choice !== '继续屏蔽') {
        return { typeCount: 0, settingEntryCount: 0, skippedCount, patterns: [] };
      }
    }

    const appliedSettings: AppliedSetting[] = [];
    let settingEntryCount = 0;
    try {
      for (const { folder, patterns } of patternsByFolder.values()) {
        const states = this.createSettingStates(folder);
        for (const state of states) {
          for (const pattern of patterns) {
            if (state.next[pattern] !== true) {
              state.next[pattern] = true;
              settingEntryCount += 1;
            }
          }
          if (settingsEqual(state.before, state.next)) {
            continue;
          }
          await state.configuration.update(
            state.target.key,
            state.next,
            vscode.ConfigurationTarget.WorkspaceFolder,
          );
          appliedSettings.push({
            configuration: state.configuration,
            key: state.target.key,
            before: state.before,
          });
          this.output.appendLine(`[按类型屏蔽] ${folder.name} / ${state.target.label}: ${[...patterns].join(', ')}`);
        }
      }
    } catch (error) {
      await this.rollback(appliedSettings);
      throw error;
    }
    return { typeCount: allPatterns.length, settingEntryCount, skippedCount, patterns: allPatterns };
  }

  public listActiveExclusions(): readonly ActiveExclusion[] {
    const exclusions: ActiveExclusion[] = [];

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const explorer = getFolderSetting(folder, SETTING_TARGETS[0]);
      const search = getFolderSetting(folder, SETTING_TARGETS[1]);
      const watcher = getFolderSetting(folder, SETTING_TARGETS[2]);

      for (const [pattern, value] of Object.entries(explorer)) {
        if (value !== true) {
          continue;
        }

        const recursivePattern = `${pattern}/**`;
        const recursive = search[recursivePattern] === true || watcher[recursivePattern] === true;
        const targets = ['目录展示'];
        if (search[pattern] === true || search[recursivePattern] === true) {
          targets.push('搜索');
        }
        if (watcher[pattern] === true || watcher[recursivePattern] === true) {
          targets.push('文件监控');
        }
        exclusions.push({
          id: `${folder.uri.toString()}::${pattern}`,
          folderUri: folder.uri.toString(),
          folderName: folder.name,
          pattern,
          recursive,
          targets,
        });
      }
    }

    return exclusions.sort((left, right) =>
      left.folderName.localeCompare(right.folderName) || left.pattern.localeCompare(right.pattern));
  }

  public async restore(exclusions: readonly ActiveExclusion[]): Promise<RestoreResult> {
    const selectedByFolder = new Map<string, Set<string>>();
    for (const exclusion of exclusions) {
      let selected = selectedByFolder.get(exclusion.folderUri);
      if (selected === undefined) {
        selected = new Set<string>();
        selectedByFolder.set(exclusion.folderUri, selected);
      }
      selected.add(stripRecursiveSuffix(exclusion.pattern));
    }

    const snapshots = this.getSnapshots();
    const usedSnapshots = new Set<ConsolidationSnapshot>();
    const appliedSettings: AppliedSetting[] = [];
    let restoredCoveredRuleCount = 0;

    try {
      for (const [folderUri, selectedPatterns] of selectedByFolder) {
        const folder = (vscode.workspace.workspaceFolders ?? [])
          .find((candidate) => candidate.uri.toString() === folderUri);
        if (folder === undefined) {
          continue;
        }

        const states = this.createSettingStates(folder);
        const stateById = new Map(states.map((state) => [state.target.id, state]));

        for (const selectedPattern of selectedPatterns) {
          for (const state of states) {
            delete state.next[selectedPattern];
            delete state.next[`${selectedPattern}/**`];
          }

          for (const snapshot of snapshots) {
            if (
              snapshot.folderUri !== folderUri
              || stripRecursiveSuffix(snapshot.parentPattern) !== selectedPattern
            ) {
              continue;
            }
            usedSnapshots.add(snapshot);
            for (const entry of snapshot.entries) {
              const coveredPath = stripRecursiveSuffix(entry.pattern);
              if (selectedPatterns.has(coveredPath)) {
                continue;
              }
              const state = stateById.get(entry.targetId);
              if (state !== undefined && !Object.hasOwn(state.next, entry.pattern)) {
                state.next[entry.pattern] = entry.value;
                restoredCoveredRuleCount += 1;
              }
            }
          }
        }

        for (const state of states) {
          if (settingsEqual(state.before, state.next)) {
            continue;
          }
          await state.configuration.update(
            state.target.key,
            state.next,
            vscode.ConfigurationTarget.WorkspaceFolder,
          );
          appliedSettings.push({
            configuration: state.configuration,
            key: state.target.key,
            before: state.before,
          });
        }
      }
    } catch (error) {
      await this.rollback(appliedSettings);
      throw error;
    }

    if (usedSnapshots.size > 0) {
      await this.workspaceState.update(
        SNAPSHOT_KEY,
        snapshots.filter((snapshot) => !usedSnapshots.has(snapshot)),
      );
    }

    return { restoredCount: exclusions.length, restoredCoveredRuleCount };
  }

  private async createPlans(resources: readonly vscode.Uri[]): Promise<{
    readonly plans: Map<string, FolderPlan>;
    readonly skippedCount: number;
  }> {
    const rawPlans = new Map<string, FolderPlan>();
    let skippedCount = 0;

    for (const uri of resources) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder === undefined) {
        skippedCount += 1;
        this.output.appendLine(`[跳过] 资源不属于当前工作区: ${uri.toString(true)}`);
        continue;
      }

      const relativePath = getWorkspaceRelativePath(folder, uri);
      if (relativePath === undefined) {
        skippedCount += 1;
        this.output.appendLine(`[跳过] 不支持屏蔽工作区根目录: ${uri.toString(true)}`);
        continue;
      }

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        const kind: ResourceKind = (stat.type & vscode.FileType.Directory) !== 0
          ? 'directory'
          : 'file';
        const resource: PlannedResource = {
          uri,
          relativePath,
          kind,
          patterns: buildExclusionPatterns(relativePath, kind),
        };
        const folderKey = folder.uri.toString();
        const plan = rawPlans.get(folderKey);
        if (plan === undefined) {
          rawPlans.set(folderKey, { folder, resources: [resource] });
        } else {
          plan.resources.push(resource);
        }
      } catch (error) {
        skippedCount += 1;
        this.output.appendLine(`[跳过] 无法读取资源类型: ${uri.toString(true)}；${formatError(error)}`);
      }
    }

    const plans = new Map<string, FolderPlan>();
    for (const [key, plan] of rawPlans) {
      const consolidated = consolidateHierarchicalResources(
        plan.resources.map((resource) => ({
          relativePath: resource.relativePath,
          kind: resource.kind,
          value: resource,
        })),
      ).map((item) => item.value);
      skippedCount += plan.resources.length - consolidated.length;
      plans.set(key, { folder: plan.folder, resources: [...consolidated] });
    }

    return { plans, skippedCount };
  }

  private async filterCoveredResources(plans: ReadonlyMap<string, FolderPlan>): Promise<{
    readonly plans: Map<string, FolderPlan>;
    readonly coveredCount: number;
  }> {
    const result = new Map<string, FolderPlan>();
    let coveredCount = 0;

    for (const [key, plan] of plans) {
      const settings = new Map<TargetId, ExcludeSetting>();
      for (const target of SETTING_TARGETS) {
        settings.set(target.id, getFolderSetting(plan.folder, target));
      }

      const filtered = plan.resources.filter((resource) => {
        const coveredInEveryTarget = SETTING_TARGETS.every((target) => {
          const current = settings.get(target.id) ?? {};
          const candidatePattern = resource.patterns[target.id];
          return Object.entries(current).some(
            ([pattern, value]) => value === true && isDescendantPattern(candidatePattern, pattern),
          );
        });
        if (coveredInEveryTarget) {
          coveredCount += 1;
          this.output.appendLine(`[跳过] 已被父目录规则覆盖: ${resource.relativePath}`);
        }
        return !coveredInEveryTarget;
      });
      if (filtered.length > 0) {
        result.set(key, { folder: plan.folder, resources: filtered });
      }
    }

    return { plans: result, coveredCount };
  }

  private createSettingStates(folder: vscode.WorkspaceFolder): SettingState[] {
    return SETTING_TARGETS.map((target) => {
      const configuration = this.getConfiguration(target.section, folder.uri);
      const before = configuration.inspect<ExcludeSetting>(target.key)?.workspaceFolderValue;
      return { target, configuration, before, next: { ...(before ?? {}) } };
    });
  }

  private async confirmExclude(resourceCount: number): Promise<boolean> {
    const shouldConfirm = vscode.workspace
      .getConfiguration('projectManager.exclusions')
      .get<boolean>('confirmBeforeApply', true);
    if (!shouldConfirm) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      `将屏蔽 ${resourceCount} 个资源，使其不再出现在目录、搜索结果和文件监控中。C/C++ 等语言扩展可能不再为被屏蔽文件提供大纲符号。`,
      { modal: true },
      '继续屏蔽',
    );
    return choice === '继续屏蔽';
  }

  private getSnapshots(): readonly ConsolidationSnapshot[] {
    return this.workspaceState.get<readonly ConsolidationSnapshot[]>(SNAPSHOT_KEY, []);
  }

  private async mergeSnapshots(incoming: readonly ConsolidationSnapshot[]): Promise<void> {
    const merged = [...this.getSnapshots()];
    for (const snapshot of incoming) {
      const index = merged.findIndex(
        (existing) => existing.folderUri === snapshot.folderUri
          && existing.parentPattern === snapshot.parentPattern,
      );
      if (index < 0) {
        merged.push(snapshot);
        continue;
      }
      const existing = merged[index];
      if (existing === undefined) {
        continue;
      }
      const entries = new Map<string, CoveredSettingEntry>();
      for (const entry of [...existing.entries, ...snapshot.entries]) {
        entries.set(`${entry.targetId}::${entry.pattern}`, entry);
      }
      merged[index] = { ...existing, entries: [...entries.values()] };
    }
    await this.workspaceState.update(SNAPSHOT_KEY, merged);
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

function getFolderSetting(
  folder: vscode.WorkspaceFolder,
  target: SettingTarget | undefined,
): ExcludeSetting {
  if (target === undefined) {
    return {};
  }
  return vscode.workspace
    .getConfiguration(target.section, folder.uri)
    .inspect<ExcludeSetting>(target.key)
    ?.workspaceFolderValue ?? {};
}

function settingsEqual(before: ExcludeSetting | undefined, next: ExcludeSetting): boolean {
  const beforeEntries = Object.entries(before ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const nextEntries = Object.entries(next).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(beforeEntries) === JSON.stringify(nextEntries);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
