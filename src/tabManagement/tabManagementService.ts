import * as vscode from 'vscode';
import { ProjectFeatureConfigurationSource } from '../configuration/configurationTypes';
import { GroupableTab, isSameOrder, moveNonProjectTabsToTail } from './tabGrouping';
import { resolveEffectiveTabSettings } from './tabSettings';

interface ManagedTab extends GroupableTab {
  readonly tab: vscode.Tab;
  readonly uri: vscode.Uri | undefined;
}

export class TabManagementService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tabIds = new WeakMap<vscode.Tab, string>();
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
        for (const group of event.closed) this.scheduledGroups.delete(group.viewColumn);
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
    if (this.isOrganizing || !this.getSettings().autoOrganize) return;
    const affected = new Set(event.opened.map((tab) => tab.group.viewColumn));
    for (const groupKey of affected) this.scheduleGroup(groupKey);
  }

  private onSettingsChanged(): void {
    const nextSignature = this.getSettingsSignature();
    if (nextSignature === this.settingsSignature) {
      return;
    }
    this.settingsSignature = nextSignature;
    if (!this.getSettings().autoOrganize) {
      this.output.appendLine('标签配置已更新：自动移至末尾处于关闭状态。');
      return;
    }
    this.output.appendLine('非项目标签自动移至末尾已开启，正在检查全部编辑器组。');
    this.requestReconcileForAllGroups();
  }

  private requestReconcileForAllGroups(): void {
    for (const group of vscode.window.tabGroups.all) {
      this.scheduleGroup(group.viewColumn);
    }
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
        const group = this.findCurrentGroup(groupKey);
        if (group !== undefined && this.getSettings().autoOrganize) await this.organizeGroup(group, false);
      })
      .catch((error: unknown) => {
        this.scheduledGroups.delete(groupKey);
        this.output.appendLine(`标签归组操作失败：${error instanceof Error ? error.message : String(error)}`);
      });
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
        await vscode.window.showErrorMessage('非项目标签移动未完成，详情请查看“项目管家”输出。');
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
