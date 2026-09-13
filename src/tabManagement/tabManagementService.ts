/**
 * 执行标签移动并维护待处理事件；tabGrouping 计算位置，pendingTabWork 决定何时可以执行。
 * 当前目标是保留工作区内文件相对顺序，将外部文件及特殊编辑器放在后方，不是按目录重排项目文件。
 * VS Code 移动命令操作活动编辑器，所以移动、激活和焦点恢复必须一起考虑；自身事件也需防止重复触发。
 */
import * as vscode from 'vscode';
import { ProjectFeatureConfigurationSource } from '../configuration/configurationTypes';
import {
  GroupableTab,
  isSameOrder,
  moveNonProjectTabsToTail,
  planSingleTabPlacement,
} from './tabGrouping';
import {
  ActiveTabKind,
  choosePendingGroupAction,
  PendingGroupSnapshot,
} from './pendingTabWork';
import { resolveEffectiveTabSettings } from './tabSettings';

interface ManagedTab extends GroupableTab {
  readonly tab: vscode.Tab;
  readonly uri: vscode.Uri | undefined;
}

export class TabManagementService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tabIds = new WeakMap<vscode.Tab, string>();
  private readonly pendingFullGroups = new Set<number>();
  private readonly pendingTextTabs = new Map<number, Set<string>>();
  private readonly pendingAuxiliaryTabs = new Map<number, Set<string>>();
  private readonly scheduledGroups = new Set<number>();
  private tabIdSequence = 0;
  private isOrganizing = false;
  private operationQueue: Promise<void> = Promise.resolve();
  private settingsSignature: string;

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly catalogService: ProjectFeatureConfigurationSource,
  ) {
    this.settingsSignature = this.getSettingsSignature();
    if (this.getSettings().autoOrganize) this.requestReconcileForAllGroups();

    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs((event) => this.onTabsChanged(event)),
      vscode.window.tabGroups.onDidChangeTabGroups((event) => {
        for (const group of event.closed) this.clearGroupState(group.viewColumn);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('projectManager.tabs')) {
          this.onSettingsChanged();
        }
      }),
      this.catalogService.onDidChange(() => {
        this.onSettingsChanged();
      }),
    );
  }

  public async organizeCurrentGroup(showPreview = true): Promise<void> {
    await this.operationQueue;
    await this.organizeGroup(vscode.window.tabGroups.activeTabGroup, showPreview);
  }

  public async waitForIdleForIntegrationTest(): Promise<void> {
    await this.operationQueue;
  }

  public dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private onTabsChanged(event: vscode.TabChangeEvent): void {
    for (const tab of event.closed) {
      this.removePendingTab(tab.group.viewColumn, this.getTabId(tab));
    }
    if (this.isOrganizing || !this.getSettings().autoOrganize) return;

    const affected = new Set<number>();
    for (const tab of event.opened) {
      const groupKey = tab.group.viewColumn;
      const tabId = this.getTabId(tab);
      if (getTextTabUri(tab) === undefined) {
        this.requestAuxiliaryTab(groupKey, tabId);
      } else {
        this.requestTextTab(groupKey, tabId);
      }
      affected.add(groupKey);
    }
    for (const tab of event.changed) {
      if (tab.isActive && this.hasPendingWork(tab.group.viewColumn)) {
        affected.add(tab.group.viewColumn);
      }
    }
    for (const groupKey of affected) this.scheduleGroup(groupKey);
  }

  private onSettingsChanged(): void {
    const nextSignature = this.getSettingsSignature();
    if (nextSignature === this.settingsSignature) {
      return;
    }
    this.settingsSignature = nextSignature;
    if (!this.getSettings().autoOrganize) {
      this.clearAllPendingWork();
      this.output.appendLine('标签配置已更新：自动移至末尾处于关闭状态。');
      return;
    }
    this.output.appendLine('非项目标签自动移至末尾已开启，正在检查全部编辑器组。');
    this.requestReconcileForAllGroups();
  }

  private requestReconcileForAllGroups(): void {
    for (const group of vscode.window.tabGroups.all) {
      const groupKey = group.viewColumn;
      this.requestFullReconcile(groupKey);
      this.scheduleGroup(groupKey);
    }
  }

  private requestFullReconcile(groupKey: number): void {
    this.pendingFullGroups.add(groupKey);
    this.pendingTextTabs.delete(groupKey);
    this.pendingAuxiliaryTabs.delete(groupKey);
  }

  private requestTextTab(groupKey: number, tabId: string): void {
    if (this.pendingFullGroups.has(groupKey)) return;
    const pending = this.pendingTextTabs.get(groupKey) ?? new Set<string>();
    pending.add(tabId);
    this.pendingTextTabs.set(groupKey, pending);
  }

  private requestAuxiliaryTab(groupKey: number, tabId: string): void {
    if (this.pendingFullGroups.has(groupKey)) return;
    const pending = this.pendingAuxiliaryTabs.get(groupKey) ?? new Set<string>();
    pending.add(tabId);
    this.pendingAuxiliaryTabs.set(groupKey, pending);
  }

  private scheduleGroup(groupKey: number): void {
    if (this.scheduledGroups.has(groupKey)) {
      return;
    }
    this.scheduledGroups.add(groupKey);
    this.operationQueue = this.operationQueue
      .then(async () => {
        await waitForTabActivationToSettle();
        this.scheduledGroups.delete(groupKey);
        await this.drainPendingGroup(groupKey);
      })
      .catch((error: unknown) => {
        this.scheduledGroups.delete(groupKey);
        this.output.appendLine(`标签归组操作失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private async drainPendingGroup(groupKey: number): Promise<void> {
    if (!this.getSettings().autoOrganize) {
      this.clearGroupPendingWork(groupKey);
      return;
    }
    const group = this.findCurrentGroup(groupKey);
    if (group === undefined) {
      this.clearGroupState(groupKey);
      return;
    }
    const activeTab = group.activeTab;
    const action = choosePendingGroupAction(
      this.getPendingSnapshot(groupKey),
      activeTab === undefined ? undefined : this.getTabId(activeTab),
      this.getActiveTabKind(activeTab),
    );
    switch (action.kind) {
      case 'none':
      case 'wait':
        return;
      case 'placeAuxiliaryTab':
        if (activeTab !== undefined && await this.placeAuxiliaryTabAtEnd(activeTab)) {
          this.removePendingAuxiliaryTab(groupKey, action.tabId);
        }
        return;
      case 'reconcileAll':
        if (await this.organizeGroup(group, false)) {
          this.clearGroupPendingWork(groupKey);
        }
        return;
      case 'placeTextTabs': {
        const result = await this.placePendingTextTabs(group, action.tabIds);
        for (const tabId of result.processed) this.removePendingTextTab(groupKey, tabId);
        if (result.needsReconcile) {
          const latestGroup = this.findCurrentGroup(groupKey);
          if (latestGroup !== undefined && await this.organizeGroup(latestGroup, false)) {
            this.clearGroupPendingWork(groupKey);
          }
        }
      }
    }
  }

  // 历史缺陷：新增一个外部文件时全组重排，会为移动命令依次激活多个页面。
  // 优先只移动本次新增标签；只有既有顺序不满足规则时，才请求全组整理。
  private async placePendingTextTabs(
    group: vscode.TabGroup,
    tabIds: readonly string[],
  ): Promise<{ readonly processed: readonly string[]; readonly needsReconcile: boolean }> {
    const currentGroup = this.findCurrentGroup(group.viewColumn);
    const originalActiveTab = currentGroup?.activeTab;
    if (currentGroup === undefined || originalActiveTab === undefined || getTextTabUri(originalActiveTab) === undefined) {
      return { processed: [], needsReconcile: false };
    }

    const originalActiveId = this.getTabId(originalActiveTab);
    // 保存的是执行移动时的活动页，不是收到“打开”事件前的旧页，避免打开后看起来没有切页。
    const processed: string[] = [];
    let needsReconcile = false;
    this.isOrganizing = true;
    try {
      for (const tabId of tabIds) {
        const latestGroup = this.findCurrentGroup(group.viewColumn);
        const tabs = latestGroup === undefined ? [] : this.getManagedTabs(latestGroup);
        const placement = planSingleTabPlacement(tabs, tabId);
        if (placement.kind === 'reconcile') {
          needsReconcile = true;
          break;
        }
        if (placement.kind === 'missing' || placement.kind === 'unchanged') {
          processed.push(tabId);
          continue;
        }
        const target = tabs.find((candidate) => candidate.id === tabId);
        if (latestGroup === undefined || target === undefined) {
          processed.push(tabId);
          continue;
        }
        await this.revealTab(target.tab, latestGroup);
        await vscode.commands.executeCommand('moveActiveEditor', {
          to: 'position',
          by: 'tab',
          value: placement.targetIndex + 1,
        });
        processed.push(tabId);
      }
    } catch (error) {
      this.output.appendLine(`新标签快速放置失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        const latestGroup = this.findCurrentGroup(group.viewColumn);
        const original = latestGroup?.tabs.find((tab) => this.getTabId(tab) === originalActiveId);
        if (latestGroup !== undefined
          && original !== undefined
          && latestGroup.activeTab !== original) {
          await this.revealTab(original, latestGroup);
        }
      } catch (error) {
        this.output.appendLine(`恢复原活动标签失败：${error instanceof Error ? error.message : String(error)}`);
      }
      this.isOrganizing = false;
    }
    return { processed, needsReconcile };
  }

  private async placeAuxiliaryTabAtEnd(tab: vscode.Tab): Promise<boolean> {
    const group = this.findCurrentGroup(tab.group.viewColumn);
    if (group === undefined || group.activeTab !== tab) return false;
    const currentIndex = group.tabs.indexOf(tab);
    if (currentIndex < 0 || currentIndex === group.tabs.length - 1) return true;
    this.isOrganizing = true;
    try {
      await vscode.commands.executeCommand('moveActiveEditor', {
        to: 'position',
        by: 'tab',
        value: group.tabs.length,
      });
      this.output.appendLine(`已将新打开的非项目标签“${tab.label}”移动到当前组末尾。`);
      return true;
    } catch (error) {
      this.output.appendLine(`非项目特殊标签移动失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      this.isOrganizing = false;
    }
  }

  private getPendingSnapshot(groupKey: number): PendingGroupSnapshot {
    return {
      fullReconcile: this.pendingFullGroups.has(groupKey),
      textTabIds: [...(this.pendingTextTabs.get(groupKey) ?? [])],
      auxiliaryTabIds: [...(this.pendingAuxiliaryTabs.get(groupKey) ?? [])],
    };
  }

  private getActiveTabKind(tab: vscode.Tab | undefined): ActiveTabKind {
    if (tab === undefined) return 'none';
    return getTextTabUri(tab) === undefined ? 'auxiliary' : 'movableText';
  }

  private hasPendingWork(groupKey: number): boolean {
    return this.pendingFullGroups.has(groupKey)
      || (this.pendingTextTabs.get(groupKey)?.size ?? 0) > 0
      || (this.pendingAuxiliaryTabs.get(groupKey)?.size ?? 0) > 0;
  }

  private removePendingTab(groupKey: number, tabId: string): void {
    this.removePendingTextTab(groupKey, tabId);
    this.removePendingAuxiliaryTab(groupKey, tabId);
  }

  private removePendingTextTab(groupKey: number, tabId: string): void {
    const pending = this.pendingTextTabs.get(groupKey);
    pending?.delete(tabId);
    if (pending?.size === 0) this.pendingTextTabs.delete(groupKey);
  }

  private removePendingAuxiliaryTab(groupKey: number, tabId: string): void {
    const pending = this.pendingAuxiliaryTabs.get(groupKey);
    pending?.delete(tabId);
    if (pending?.size === 0) this.pendingAuxiliaryTabs.delete(groupKey);
  }

  private clearGroupPendingWork(groupKey: number): void {
    this.pendingFullGroups.delete(groupKey);
    this.pendingTextTabs.delete(groupKey);
    this.pendingAuxiliaryTabs.delete(groupKey);
  }

  private clearGroupState(groupKey: number): void {
    this.clearGroupPendingWork(groupKey);
    this.scheduledGroups.delete(groupKey);
  }

  private clearAllPendingWork(): void {
    this.pendingFullGroups.clear();
    this.pendingTextTabs.clear();
    this.pendingAuxiliaryTabs.clear();
  }

  private async organizeGroup(group: vscode.TabGroup, showPreview: boolean): Promise<boolean> {
    if (this.isOrganizing) {
      return false;
    }
    const originalActiveTab = group.activeTab;
    if (originalActiveTab !== undefined && getTextTabUri(originalActiveTab) === undefined) {
      const currentIndex = group.tabs.indexOf(originalActiveTab);
      if (currentIndex >= 0 && currentIndex < group.tabs.length - 1) {
        this.isOrganizing = true;
        try {
          await vscode.commands.executeCommand('moveActiveEditor', {
            to: 'position',
            by: 'tab',
            value: group.tabs.length,
          });
          this.output.appendLine(`已将新打开的非项目标签“${originalActiveTab.label}”移动到当前组末尾。`);
        } catch (error) {
          this.output.appendLine(`非项目特殊标签移动失败：${error instanceof Error ? error.message : String(error)}`);
          return false;
        } finally {
          this.isOrganizing = false;
        }
      }
      return true;
    }

    const tabs = this.getManagedTabs(group);
    const currentOrder = tabs.map((tab) => tab.id);
    const targetOrder = moveNonProjectTabsToTail(tabs);
    if (isSameOrder(currentOrder, targetOrder)) {
      if (showPreview) {
        await vscode.window.showInformationMessage('当前标签组的非项目标签已经位于末尾。');
      } else {
        this.output.appendLine(`编辑器组 ${group.viewColumn} 的非项目标签已经位于末尾，无需移动。`);
      }
      return true;
    }

    if (showPreview) {
      const confirmed = await vscode.window.showInformationMessage(
        '确认将当前组的工作区外及非项目标签移到末尾吗？',
        {
          modal: true,
          detail: `${formatOrderPreview('当前', tabs, currentOrder)}\n\n${formatOrderPreview('目标', tabs, targetOrder)}\n\n项目内文件之间的顺序不会改变。`,
        },
        '移到末尾',
      );
      if (confirmed !== '移到末尾') {
        return false;
      }
    }

    this.isOrganizing = true;
    try {
      for (let targetIndex = 0; targetIndex < targetOrder.length; targetIndex += 1) {
        const desiredId = targetOrder[targetIndex];
        const currentGroup = this.findCurrentGroup(group.viewColumn);
        const currentTabs = currentGroup === undefined ? [] : this.getManagedTabs(currentGroup);
        const currentIndex = currentTabs.findIndex((tab) => tab.id === desiredId);
        const desiredTab = currentTabs[currentIndex];
        if (currentIndex < 0 || currentIndex === targetIndex || desiredTab === undefined || desiredTab.uri === undefined) {
          continue;
        }
        await this.revealTab(desiredTab.tab, currentGroup ?? group);
        await vscode.commands.executeCommand('moveActiveEditor', {
          to: 'position',
          by: 'tab',
          value: targetIndex + 1,
        });
      }
      const finalGroup = this.findCurrentGroup(group.viewColumn);
      if (finalGroup !== undefined && originalActiveTab !== undefined && getTextTabUri(originalActiveTab) !== undefined) {
        await this.revealTab(originalActiveTab, finalGroup);
      }
      this.output.appendLine(`已将编辑器组 ${group.viewColumn} 的非项目标签稳定移动到末尾。`);
      return true;
    } catch (error) {
      this.output.appendLine(`非项目标签移动失败：${error instanceof Error ? error.message : String(error)}`);
      if (showPreview) {
        await vscode.window.showErrorMessage('非项目标签移动未完成，详情请查看“CAtlas Hub”输出。');
      }
      return false;
    } finally {
      this.isOrganizing = false;
    }
  }

  private getManagedTabs(group: vscode.TabGroup): ManagedTab[] {
    return group.tabs.map((tab): ManagedTab => {
      const uri = getTextTabUri(tab);
      const category = getTabCategory(uri);
      return {
        id: this.getTabId(tab),
        category,
        tab,
        uri,
      };
    });
  }

  private getTabId(tab: vscode.Tab): string {
    const uri = getTextTabUri(tab);
    if (uri !== undefined) {
      return `group-${tab.group.viewColumn}:text:${uri.toString()}`;
    }
    const existing = this.tabIds.get(tab);
    if (existing !== undefined) {
      return existing;
    }
    this.tabIdSequence += 1;
    const id = `special-${this.tabIdSequence}`;
    this.tabIds.set(tab, id);
    return id;
  }

  private findCurrentGroup(viewColumn: vscode.ViewColumn): vscode.TabGroup | undefined {
    return vscode.window.tabGroups.all.find((group) => group.viewColumn === viewColumn);
  }

  private async revealTab(tab: vscode.Tab, group: vscode.TabGroup): Promise<void> {
    const uri = getTextTabUri(tab);
    if (uri === undefined) {
      return;
    }
    await vscode.window.showTextDocument(uri, {
      viewColumn: group.viewColumn,
      preserveFocus: false,
      preview: tab.isPreview,
    });
  }

  private getSettings() {
    return resolveEffectiveTabSettings(this.catalogService.currentProjectTabSettings).values;
  }

  private getSettingsSignature(): string {
    const settings = this.getSettings();
    return String(settings.autoOrganize);
  }
}

async function waitForTabActivationToSettle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

function getTextTabUri(tab: vscode.Tab): vscode.Uri | undefined {
  if (!(tab.input instanceof vscode.TabInputText)
    || (tab.input.uri.scheme !== 'file' && tab.input.uri.scheme !== 'vscode-remote')) {
    return undefined;
  }
  return tab.input.uri;
}

function getTabCategory(uri: vscode.Uri | undefined): GroupableTab['category'] {
  if (uri === undefined) {
    return 'external';
  }
  return vscode.workspace.getWorkspaceFolder(uri) === undefined ? 'external' : 'project';
}

function formatOrderPreview(title: string, tabs: readonly ManagedTab[], order: readonly string[]): string {
  const labels = new Map(tabs.map((tab) => [tab.id, tab.tab.label]));
  return `${title}：${order.map((id) => labels.get(id) ?? id).join(' | ')}`;
}
