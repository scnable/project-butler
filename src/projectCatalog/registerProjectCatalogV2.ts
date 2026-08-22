import * as vscode from 'vscode';
import { ConfigurationTreeNode, ConfigurationTreeProvider } from '../configuration/configurationTreeProvider';
import { CatalogTabSettingKey, CatalogTodoSettingKey, ProjectCatalogServiceV2, ResolvedCatalogProject } from './catalogServiceV2';
import { ProjectCatalogTreeProviderV2 } from './catalogTreeProviderV2';

export interface RegisteredProjectCatalogV2 {
  readonly service: ProjectCatalogServiceV2;
  readonly projectProvider: ProjectCatalogTreeProviderV2;
  readonly configurationProvider: ConfigurationTreeProvider;
  readonly projectView: vscode.TreeView<import('./catalogTreeProviderV2').ProjectCatalogTreeNodeV2>;
  readonly configurationView: vscode.TreeView<ConfigurationTreeNode>;
  readonly initialization: Promise<void>;
}

export function registerProjectCatalogV2(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): RegisteredProjectCatalogV2 {
  const service = new ProjectCatalogServiceV2(context, output);
  const projectProvider = new ProjectCatalogTreeProviderV2(service, context.extensionUri);
  const projectView = vscode.window.createTreeView('projectManager.projectsView', {
    treeDataProvider: projectProvider,
    showCollapseAll: false,
  });
  const configurationProvider = new ConfigurationTreeProvider(
    service,
    context.globalState,
    undefined,
    undefined,
    context.extensionUri,
  );
  const configurationView = vscode.window.createTreeView('projectManager.configurationView', {
    treeDataProvider: configurationProvider,
    showCollapseAll: true,
  });

  const updateViewState = (): void => {
    const catalog = service.current;
    projectView.description = catalog?.name ?? '';
    projectView.message = catalog === undefined
      ? service.catalogs.length === 0
        ? '添加项目即可创建第一个集合，也可以导入已有集合。'
        : '请选择一个集合，或继续添加、导入项目集合。'
      : catalog.projects.length === 0 ? '当前集合还没有项目，请使用“添加项目”。' : '';
    configurationView.description = catalog === undefined ? '个人默认' : catalog.name;
    void vscode.commands.executeCommand('setContext', 'projectManager.hasActiveCatalog', catalog !== undefined);
    void vscode.commands.executeCommand('setContext', 'projectManager.hasCatalogs', service.catalogs.length > 0);
    void vscode.commands.executeCommand('setContext', 'projectManager.hasLegacyCatalogToImport', service.hasLegacyCatalogToImport);
    void vscode.commands.executeCommand('setContext', 'projectManager.catalogInitializing', false);
  };

  const openProject = async (project: ResolvedCatalogProject | undefined, mode?: 'newWindow' | 'currentWindow'): Promise<void> => {
    if (project === undefined) {
      await vscode.window.showInformationMessage('请从“项目集合”视图中选择要打开的项目。');
      return;
    }
    await service.openProject(project, mode);
  };

  context.subscriptions.push(
    service,
    projectProvider,
    projectView,
    configurationProvider,
    configurationView,
    service.onDidChange(updateViewState),
    configurationView.onDidExpandElement((event) => {
      const node = event.element as ConfigurationTreeNode;
      if (node.kind === 'group') void configurationProvider.setGroupExpanded(node.id, true);
    }),
    configurationView.onDidCollapseElement((event) => {
      const node = event.element as ConfigurationTreeNode;
      if (node.kind === 'group') void configurationProvider.setGroupExpanded(node.id, false);
    }),
    vscode.commands.registerCommand('projectManager.selectCatalog', async () => service.selectCatalog()),
    vscode.commands.registerCommand('projectManager.addProjectToCatalog', async () => service.addProjectToCatalog()),
    vscode.commands.registerCommand('projectManager.importCatalog', async () => service.importCatalog()),
    vscode.commands.registerCommand('projectManager.importLegacyCatalog', async () => service.importLegacyCatalog()),
    vscode.commands.registerCommand('projectManager.exportCatalog', async () => service.exportCatalog()),
    vscode.commands.registerCommand('projectManager.exitCatalog', async () => service.exitCatalog()),
    vscode.commands.registerCommand('projectManager.configureCatalogTabSetting', async (key?: CatalogTabSettingKey) => {
      if (key !== undefined) await service.configureTabSetting(key);
    }),
    vscode.commands.registerCommand('projectManager.configureCatalogOutlineMode', async () => service.configureOutlineMode()),
    vscode.commands.registerCommand('projectManager.configureCatalogTodoSetting', async (key?: CatalogTodoSettingKey) => {
      if (key !== undefined) await service.configureTodoSetting(key);
    }),
    vscode.commands.registerCommand('projectManager.configurePersonalSetting', async (key?: Parameters<ConfigurationTreeProvider['configurePersonalSetting']>[0]) => {
      if (key !== undefined) await configurationProvider.configurePersonalSetting(key);
    }),
    vscode.commands.registerCommand('projectManager.refreshProjects', async () => service.refresh()),
    vscode.commands.registerCommand('projectManager.closeCatalog', async () => service.exitCatalog()),
    vscode.commands.registerCommand('projectManager.openCatalogFile', async () => service.importCatalog()),
    vscode.commands.registerCommand('projectManager.createCatalogTemplate', async () => service.addProjectToCatalog()),
    vscode.commands.registerCommand('projectManager.openCatalogSource', async () => {
      await vscode.window.showInformationMessage('当前集合由插件内部管理；如需查看或迁移数据，请使用“导出集合”。');
    }),
    vscode.commands.registerCommand('projectManager.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
    }),
    vscode.commands.registerCommand('projectManager.openProject', async (project?: ResolvedCatalogProject) => openProject(project)),
    vscode.commands.registerCommand('projectManager.openProjectInNewWindow', async (project?: ResolvedCatalogProject) => openProject(project, 'newWindow')),
    vscode.commands.registerCommand('projectManager.openProjectInCurrentWindow', async (project?: ResolvedCatalogProject) => openProject(project, 'currentWindow')),
    vscode.commands.registerCommand('projectManager.renameCatalog', async () => service.renameCatalog()),
    vscode.commands.registerCommand('projectManager.renameProjectAlias', async (project?: ResolvedCatalogProject) => {
      if (project !== undefined) await service.renameProjectAlias(project);
    }),
    vscode.commands.registerCommand('projectManager.reselectProjectPath', async (project?: ResolvedCatalogProject) => {
      if (project !== undefined) await service.reselectProjectPath(project);
    }),
    vscode.commands.registerCommand('projectManager.removeProjectFromCatalog', async (project?: ResolvedCatalogProject) => {
      if (project !== undefined) await service.removeProjectFromCatalog(project);
    }),
  );

  void vscode.commands.executeCommand('setContext', 'projectManager.catalogInitializing', true);
  const initialization = service.initialize().finally(updateViewState);
  return { service, projectProvider, configurationProvider, projectView, configurationView, initialization };
}
