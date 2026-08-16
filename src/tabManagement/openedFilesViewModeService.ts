import * as vscode from 'vscode';

export type OpenedFilesViewMode = 'native' | 'directoryTree';

const MODE_CONTEXT = 'projectManager.openedFilesDirectoryTreeEnabled';
const DECISION_KEY = 'projectManager.openedFilesView.nativeOpenEditorsDecision';
const RESTORE_KEY = 'projectManager.openedFilesView.nativeOpenEditorsRestore';
const COMMAND_HIDE_KEY = 'projectManager.openedFilesView.nativeOpenEditorsHiddenByCommand';
const NATIVE_VIEW_REMOVE_COMMAND = 'workbench.explorer.openEditorsView.removeView';
const NATIVE_VIEW_OPEN_COMMAND = 'workbench.explorer.openEditorsView.open';

interface RestoreRecord {
  readonly target: 'global' | 'workspace';
  readonly hadExplicitValue: boolean;
  readonly previousValue?: number;
  readonly writtenValue: number;
}

export interface OpenedFilesViewInteraction {
  confirmHideNative(modal: boolean): Promise<boolean>;
  showInformation(message: string): Promise<void>;
  showWarning(message: string): Promise<void>;
  showModalWarning?(message: string): Promise<void>;
  showModalInformation?(message: string): Promise<void>;
}

export class OpenedFilesViewModeService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private applying = false;
  private initialized = false;

  public constructor(
    private readonly state: vscode.Memento,
    private readonly output: vscode.OutputChannel,
    private readonly interaction: OpenedFilesViewInteraction = defaultInteraction,
  ) {
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('projectManager.tabs.openFilesView')) void this.applyMode(true);
    }));
    void this.applyMode(true);
  }

  public get mode(): OpenedFilesViewMode {
    return vscode.workspace.getConfiguration('projectManager.tabs')
      .get<OpenedFilesViewMode>('openFilesView', 'directoryTree');
  }

  public async applyMode(askBeforeHiding: boolean): Promise<void> {
    if (!this.initialized) {
      this.initialized = true;
      askBeforeHiding = false;
    }
    if (this.applying) return;
    this.applying = true;
    try {
      const directoryTree = this.mode === 'directoryTree';
      await vscode.commands.executeCommand('setContext', MODE_CONTEXT, directoryTree);
      if (!directoryTree) {
        await this.restoreNativeOpenEditors(false);
        return;
      }
      const decision = this.state.get<'accepted' | 'declined'>(DECISION_KEY);
      if (decision === 'accepted') {
        if (!(await this.hideNativeOpenEditors(false))) await this.state.update(DECISION_KEY, 'declined');
      } else if (askBeforeHiding && decision !== 'declined') {
        const accepted = await this.interaction.confirmHideNative(false);
        await this.state.update(DECISION_KEY, accepted ? 'accepted' : 'declined');
        if (accepted && !(await this.hideNativeOpenEditors(false))) {
          await this.state.update(DECISION_KEY, 'declined');
        }
      }
    } finally {
      this.applying = false;
    }
  }

  public async requestNativeMutualExclusion(): Promise<void> {
    const accepted = await this.interaction.confirmHideNative(true);
    await this.state.update(DECISION_KEY, accepted ? 'accepted' : 'declined');
    if (accepted && !(await this.hideNativeOpenEditors(true))) {
      await this.state.update(DECISION_KEY, 'declined');
    }
  }

  public async restoreNativeOpenEditors(showMessage = true): Promise<void> {
    const hiddenByCommand = this.state.get<boolean>(COMMAND_HIDE_KEY, false);
    if (hiddenByCommand) {
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes(NATIVE_VIEW_OPEN_COMMAND)) {
        try {
          await vscode.commands.executeCommand(NATIVE_VIEW_OPEN_COMMAND);
          await this.state.update(COMMAND_HIDE_KEY, undefined);
          this.output.appendLine('已通过 VS Code 原生视图命令恢复“打开的编辑器”。');
          if (showMessage && this.interaction.showModalInformation !== undefined) {
            await this.interaction.showModalInformation('已恢复原生“打开的编辑器”。');
            showMessage = false;
          }
          if (showMessage) await this.interaction.showInformation('已恢复原生“打开的编辑器”。');
          return;
        } catch (error) {
          this.output.appendLine(`通过原生视图命令恢复“打开的编辑器”失败：${error instanceof Error ? error.message : String(error)}`);
          if (showMessage) await this.interaction.showWarning('恢复原生“打开的编辑器”失败，请在资源管理器的“视图”菜单中手动勾选。');
          return;
        }
      }
      this.output.appendLine('当前 VS Code 未注册原生“打开的编辑器”恢复命令。');
      if (showMessage) await this.showManualHideWarning('当前 VS Code 无法通过已注册命令恢复原生“打开的编辑器”。');
      return;
    }
    const record = this.state.get<RestoreRecord>(RESTORE_KEY);
    if (record === undefined) {
      if (showMessage) await this.interaction.showInformation('没有由本插件隐藏、需要恢复的原生“打开的编辑器”设置。');
      return;
    }
    const configuration = vscode.workspace.getConfiguration('explorer');
    const inspected = configuration.inspect<number>('openEditors.visible');
    const currentExplicit = record.target === 'workspace' ? inspected?.workspaceValue : inspected?.globalValue;
    if (currentExplicit === record.writtenValue) {
      await configuration.update(
        'openEditors.visible',
        record.hadExplicitValue ? record.previousValue : undefined,
        record.target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
      );
      this.output.appendLine('已安全恢复原生“打开的编辑器”的原设置。');
      if (showMessage) await this.interaction.showInformation('已恢复原生“打开的编辑器”。');
    } else {
      this.output.appendLine('未恢复原生“打开的编辑器”：设置已被用户或其他扩展修改。');
      if (showMessage) await this.interaction.showInformation('检测到该设置后来被修改，插件未覆盖当前值。');
    }
    await this.state.update(RESTORE_KEY, undefined);
  }

  public getRestoreRecordForIntegrationTest(): RestoreRecord | undefined {
    return this.state.get<RestoreRecord>(RESTORE_KEY);
  }

  public getCommandHideStateForIntegrationTest(): boolean {
    return this.state.get<boolean>(COMMAND_HIDE_KEY, false);
  }

  public dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async hideNativeOpenEditors(showSuccess: boolean): Promise<boolean> {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes(NATIVE_VIEW_REMOVE_COMMAND)) {
      try {
        await vscode.commands.executeCommand(NATIVE_VIEW_REMOVE_COMMAND);
        await this.state.update(COMMAND_HIDE_KEY, true);
        this.output.appendLine('已通过 VS Code 原生视图命令隐藏“打开的编辑器”。');
        if (showSuccess && this.interaction.showModalInformation !== undefined) {
          await this.interaction.showModalInformation('已隐藏原生“打开的编辑器”。');
          showSuccess = false;
        }
        if (showSuccess) await this.interaction.showInformation('已隐藏原生“打开的编辑器”。');
        return true;
      } catch (error) {
        this.output.appendLine(`通过原生视图命令隐藏“打开的编辑器”失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const configuration = vscode.workspace.getConfiguration('explorer');
    if (configuration.get<number>('openEditors.visible') !== 0) {
      this.output.appendLine('未写入 explorer.openEditors.visible = 0：VS Code 公开配置模式规定该值最小为 1。');
      await this.showManualHideWarning('VS Code 的公开配置模式规定 explorer.openEditors.visible 的最小值为 1。');
      return false;
    }
    const inspected = configuration.inspect<number>('openEditors.visible');
    if (inspected === undefined) {
      this.output.appendLine('当前 VS Code 未提供 explorer.openEditors.visible，无法自动隐藏原生“打开的编辑器”。');
      await this.showManualHideWarning('当前 VS Code 未提供可用于隐藏原生“打开的编辑器”的公开配置。');
      return false;
    }
    if (configuration.get<number>('openEditors.visible') === 0) {
      if (showSuccess) {
        await this.interaction.showInformation('原生“打开的编辑器”数量设置已经是 0；如果视图仍显示，请在其标题或资源管理器“视图”菜单中手动取消显示。');
      }
      return true;
    }
    const target = inspected.workspaceValue === undefined ? 'global' : 'workspace';
    const previousValue = target === 'workspace' ? inspected.workspaceValue : inspected.globalValue;
    const record: RestoreRecord = {
      target,
      hadExplicitValue: previousValue !== undefined,
      ...(previousValue === undefined ? {} : { previousValue }),
      writtenValue: 0,
    };
    await this.state.update(RESTORE_KEY, record);
    try {
      await configuration.update(
        'openEditors.visible',
        0,
        target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
      );
    } catch (error) {
      await this.state.update(RESTORE_KEY, undefined);
      this.output.appendLine(`隐藏原生“打开的编辑器”失败：${error instanceof Error ? error.message : String(error)}`);
      await this.showManualHideWarning('当前 VS Code 拒绝把 explorer.openEditors.visible 设置为 0。');
      return false;
    }
    if (configuration.get<number>('openEditors.visible') !== 0) {
      await configuration.update(
        'openEditors.visible',
        record.hadExplicitValue ? record.previousValue : undefined,
        target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
      );
      await this.state.update(RESTORE_KEY, undefined);
      this.output.appendLine('当前 VS Code 未接受 explorer.openEditors.visible = 0，已恢复原设置。');
      await this.showManualHideWarning('当前 VS Code 已把 explorer.openEditors.visible 的最小值限制为 1。');
      return false;
    }
    this.output.appendLine('已隐藏原生“打开的编辑器”，原显式设置已记录，可安全恢复。');
    if (showSuccess) await this.interaction.showInformation('已隐藏原生“打开的编辑器”。');
    return true;
  }

  private async showManualHideWarning(reason: string): Promise<void> {
    if (this.interaction.showModalWarning !== undefined) {
      await this.interaction.showModalWarning(
        `${reason} 插件无法再通过公开 API 自动隐藏该视图。请在原生“打开的编辑器”标题处右键，或打开资源管理器的“视图”菜单，手动取消显示“打开的编辑器”。`,
      );
      return;
    }
    await this.interaction.showWarning(
      `${reason} 插件无法再通过公开 API 自动隐藏该视图。请在原生“打开的编辑器”标题处右键，或打开资源管理器的“视图”菜单，手动取消显示“打开的编辑器”。`,
    );
  }
}

const defaultInteraction: OpenedFilesViewInteraction = {
  async confirmHideNative(modal) {
    modal = true;
    const result = await vscode.window.showWarningMessage(
      '“已打开文件目录”已启用。是否隐藏原生“打开的编辑器”，避免两个视图重复？',
      { modal, detail: '插件会先尝试公开设置；若当前 VS Code 已禁止设置为 0，将给出手动隐藏方法，不会留下错误配置。' },
      '隐藏原生视图',
    );
    return result === '隐藏原生视图';
  },
  async showInformation(message) {
    await vscode.window.showInformationMessage(message);
  },
  async showWarning(message) {
    await vscode.window.showWarningMessage(message);
  },
  async showModalWarning(message) {
    await vscode.window.showWarningMessage(message, { modal: true });
  },
  async showModalInformation(message) {
    await vscode.window.showInformationMessage(message, { modal: true });
  },
};
