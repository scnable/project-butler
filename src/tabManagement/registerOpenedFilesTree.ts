import * as vscode from 'vscode';
import { OpenedFilesTreeProvider } from './openedFilesTreeProvider';
import { OpenedFilesViewModeService } from './openedFilesViewModeService';

export interface RegisteredOpenedFilesTree {
  readonly provider: OpenedFilesTreeProvider;
  readonly modeService: OpenedFilesViewModeService;
}

export function registerOpenedFilesTree(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): RegisteredOpenedFilesTree {
  const provider = new OpenedFilesTreeProvider(output, context.extensionUri);
  const view = vscode.window.createTreeView('projectManager.openedFilesView', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  provider.attachTreeView(view);
  const modeService = new OpenedFilesViewModeService(context.globalState, output);
  context.subscriptions.push(
    provider,
    view,
    modeService,
    vscode.commands.registerCommand('projectManager.focusOpenedFile', async (node) => provider.focusFile(node)),
    vscode.commands.registerCommand('projectManager.collapseOpenedFilesNode', (node) => provider.collapse(node)),
    vscode.commands.registerCommand('projectManager.expandOpenedFilesNode', (node) => provider.expand(node)),
    vscode.commands.registerCommand('projectManager.collapseAllOpenedFiles', () => provider.collapseAll()),
    vscode.commands.registerCommand('projectManager.expandAllOpenedFiles', () => provider.expandAll()),
    vscode.commands.registerCommand('projectManager.hideNativeOpenEditors', async () => modeService.requestNativeMutualExclusion()),
    vscode.commands.registerCommand('projectManager.restoreNativeOpenEditors', async () => modeService.restoreNativeOpenEditors()),
  );
  return { provider, modeService };
}
