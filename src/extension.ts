import * as vscode from 'vscode';
import { registerExcludeResourcesCommand } from './exclusions/excludeResourcesCommand';
import { ExclusionServiceV2 } from './exclusions/exclusionServiceV2';
import { registerManageExclusionsCommand } from './exclusions/manageExclusionsCommand';
import { ExternalFileMonitor } from './externalFiles/externalFileMonitor';
import { registerProjectCatalogV2 } from './projectCatalog/registerProjectCatalogV2';
import { registerSymbolOutline } from './symbolOutline/symbolOutlineViewProvider';
import { registerTabManagement } from './tabManagement/registerTabManagement';
import { registerOpenedFilesTree } from './tabManagement/registerOpenedFilesTree';
import { ProjectButlerApi } from './testing/projectButlerApi';
import { registerTodo } from './todo/registerTodo';
import { bindTodoFeatureConfigurationSource } from './todo/todoSettings';

export function activate(context: vscode.ExtensionContext): ProjectButlerApi {
  const output = vscode.window.createOutputChannel('项目管家');
  const exclusionService = new ExclusionServiceV2(output, context.workspaceState);
  const externalFileMonitor = new ExternalFileMonitor(output);

  context.subscriptions.push(
    output,
    externalFileMonitor,
    vscode.commands.registerCommand(
      'projectManager.showExternalFiles',
      async () => externalFileMonitor.showOpenExternalFiles(),
    ),
    vscode.commands.registerCommand(
      'projectManager.diagnoseActiveFile',
      async () => externalFileMonitor.diagnoseActiveFile(),
    ),
  );

  registerExcludeResourcesCommand(context, exclusionService, output);
  registerManageExclusionsCommand(context, exclusionService, output);
  const catalogs = registerProjectCatalogV2(context, output);
  context.subscriptions.push(bindTodoFeatureConfigurationSource(catalogs.service));
  const tabs = registerTabManagement(context, output, catalogs.service);
  const openedFilesTree = registerOpenedFilesTree(context, output);
  const outline = registerSymbolOutline(context, output, catalogs.service);
  const todo = registerTodo(context, output, catalogs.service);
  output.appendLine('项目管家已激活。');
  return {
    context,
    output,
    exclusions: exclusionService,
    externalFiles: externalFileMonitor,
    catalogs,
    tabs,
    openedFilesTree,
    outline,
    todo,
  };
}

export function deactivate(): void {
  // 所有资源均由 ExtensionContext.subscriptions 统一释放。
}
