import * as vscode from 'vscode';
import { CatalogTabSettingKey, ProjectCatalogService, ResolvedCatalogProject } from './catalogService';
import { getCatalogViewDescription, ProjectCatalogTreeProvider } from './catalogTreeProvider';

export function registerProjectCatalog(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): ProjectCatalogService {
  const diagnostics = vscode.languages.createDiagnosticCollection('projectButlerCatalog');
  const service = new ProjectCatalogService(context, diagnostics, output);
  const provider = new ProjectCatalogTreeProvider(service);
  const view = vscode.window.createTreeView('projectManager.projectsView', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  const updateViewState = (): void => {
    view.description = getCatalogViewDescription(service.current) ?? '';
    view.message = service.current === undefined
      ? service.lastRestoreIssue ?? '创建新的集合配置文件，或打开已有的 *.project-butler.json。'
      : service.current.projects.length === 0
        ? '当前集合还没有项目，可使用“添加项目”继续。'
        : '';
    void vscode.commands.executeCommand('setContext', 'projectManager.hasActiveCatalog', service.current !== undefined);
    void vscode.commands.executeCommand('setContext', 'projectManager.catalogInitializing', false);
  };

  const openProject = async (
    project: ResolvedCatalogProject | undefined,
    mode?: 'newWindow' | 'currentWindow',
  ): Promise<void> => {
    if (project === undefined) {
      await vscode.window.showInformationMessage('请从“项目集合”视图中选择要打开的项目。');
      return;
    }
    await service.openProject(project, mode);
  };

  context.subscriptions.push(
    diagnostics,
    service,
    provider,
    view,
    service.onDidChange(updateViewState),
    vscode.commands.registerCommand('projectManager.configureCatalogTabSetting', async (key?: CatalogTabSettingKey) => {
      if (key !== undefined) {
        await service.configureTabSetting(key);
      }
    }),
    vscode.commands.registerCommand('projectManager.configureCatalogOutlineMode', async () => {
      await service.configureOutlineMode();
    }),
    vscode.commands.registerCommand('projectManager.closeCatalog', async () => service.closeCatalog()),
    vscode.commands.registerCommand('projectManager.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
    }),
    vscode.commands.registerCommand('projectManager.addProjectToCatalog', async () => service.addProjectToCatalog()),
    vscode.commands.registerCommand('projectManager.createCatalogTemplate', async () => service.createCatalogTemplate()),
    vscode.commands.registerCommand('projectManager.openCatalogFile', async () => service.selectCatalogFile()),
    vscode.commands.registerCommand('projectManager.openCatalogSource', async () => service.showSource()),
    vscode.commands.registerCommand('projectManager.refreshProjects', async () => service.refresh()),
    vscode.commands.registerCommand('projectManager.openProject', async (project?: ResolvedCatalogProject) => openProject(project)),
    vscode.commands.registerCommand('projectManager.openProjectInNewWindow', async (project?: ResolvedCatalogProject) => openProject(project, 'newWindow')),
    vscode.commands.registerCommand('projectManager.openProjectInCurrentWindow', async (project?: ResolvedCatalogProject) => openProject(project, 'currentWindow')),
  );

  void vscode.commands.executeCommand('setContext', 'projectManager.catalogInitializing', true);
  void service.initialize().finally(updateViewState);
  return service;
}
