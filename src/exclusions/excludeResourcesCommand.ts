import * as vscode from 'vscode';
import { ExclusionServiceV2 } from './exclusionServiceV2';
import { collectSelectedUris } from '../shared/uri';

export function registerExcludeResourcesCommand(
  context: vscode.ExtensionContext,
  service: ExclusionServiceV2,
  output: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'projectManager.excludeResources',
      async (primary?: vscode.Uri, selected?: readonly vscode.Uri[]) => {
        const resources = collectSelectedUris(primary, selected);
        if (resources.length === 0) {
          await vscode.window.showInformationMessage(
            '请在资源管理器中选择一个或多个文件/文件夹，然后使用右键菜单执行屏蔽。',
          );
          return;
        }

        try {
          const result = await service.exclude(resources);
          if (result.resourceCount === 0) {
            if (result.skippedCount > 0) {
              await vscode.window.showWarningMessage(
                `没有可屏蔽的资源，已跳过 ${result.skippedCount} 项。详情请查看“项目管家”输出。`,
              );
            }
            return;
          }

          const skipped = result.skippedCount > 0
            ? `，跳过 ${result.skippedCount} 项`
            : '';
          const consolidated = result.redundantRuleCount > 0
            ? `，合并 ${result.redundantRuleCount} 条重复子规则`
            : '';
          await vscode.window.showInformationMessage(
            `已屏蔽 ${result.resourceCount} 个资源，更新 ${result.settingEntryCount} 条设置${consolidated}${skipped}。`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.appendLine(`[错误] 屏蔽资源失败: ${message}`);
          await vscode.window.showErrorMessage(
            `屏蔽资源失败：${message}`,
            '查看输出',
          ).then(async (choice) => {
            if (choice === '查看输出') {
              output.show(true);
            }
          });
        }
      },
    ),
    vscode.commands.registerCommand(
      'projectManager.excludeSameFileType',
      async (primary?: vscode.Uri, selected?: readonly vscode.Uri[]) => {
        const resources = collectSelectedUris(primary, selected);
        if (resources.length === 0) {
          await vscode.window.showInformationMessage('请在资源管理器中选择一个或多个文件，然后执行按类型屏蔽。');
          return;
        }
        try {
          const result = await service.excludeFileTypes(resources);
          if (result.typeCount === 0) {
            if (result.skippedCount > 0) {
              await vscode.window.showWarningMessage(`没有可屏蔽的文件类型，已跳过 ${result.skippedCount} 项。`);
            }
            return;
          }
          await vscode.window.showInformationMessage(
            `已屏蔽 ${result.typeCount} 种文件类型（${result.patterns.join('、')}），更新 ${result.settingEntryCount} 条设置。`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.appendLine(`[错误] 按类型屏蔽失败: ${message}`);
          await vscode.window.showErrorMessage(`按类型屏蔽失败：${message}`);
        }
      },
    ),
  );
}
