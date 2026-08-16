import * as vscode from 'vscode';
import {
  ExclusionServiceV2,
  type ActiveExclusion,
} from './exclusionServiceV2';

interface ExclusionQuickPickItem extends vscode.QuickPickItem {
  readonly exclusion: ActiveExclusion;
}

export function registerManageExclusionsCommand(
  context: vscode.ExtensionContext,
  service: ExclusionServiceV2,
  output: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('projectManager.manageExclusions', async () => {
      const exclusions = service.listActiveExclusions();
      if (exclusions.length === 0) {
        await vscode.window.showInformationMessage('当前工作区没有可管理的目录展示屏蔽规则。');
        return;
      }

      const items: ExclusionQuickPickItem[] = exclusions.map((exclusion) => ({
        label: `$(eye-closed) ${exclusion.pattern}`,
        description: exclusion.folderName,
        detail: `${exclusion.recursive ? '目录规则' : '文件规则'}；作用于：${exclusion.targets.join('、')}`,
        exclusion,
      }));
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: '选择要取消屏蔽的文件或目录规则',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (selected === undefined || selected.length === 0) {
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `将取消 ${selected.length} 条屏蔽规则。`,
        { modal: true },
        '取消屏蔽',
      );
      if (confirmation !== '取消屏蔽') {
        return;
      }

      try {
        const result = await service.restore(selected.map((item) => item.exclusion));
        const restoredCovered = result.restoredCoveredRuleCount > 0
          ? `，并恢复 ${result.restoredCoveredRuleCount} 条此前被父目录覆盖的设置`
          : '';
        await vscode.window.showInformationMessage(
          `已取消 ${result.restoredCount} 条屏蔽规则${restoredCovered}。`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[错误] 取消屏蔽失败: ${message}`);
        await vscode.window.showErrorMessage(`取消屏蔽失败：${message}`);
      }
    }),
  );
}
