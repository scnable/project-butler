import * as vscode from 'vscode';
import { ProjectFeatureConfigurationSource } from '../configuration/configurationTypes';
import { TabManagementService } from './tabManagementService';

export function registerTabManagement(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  catalogService: ProjectFeatureConfigurationSource,
): TabManagementService {
  const service = new TabManagementService(output, catalogService);
  context.subscriptions.push(
    service,
    vscode.commands.registerCommand('projectManager.organizeCurrentTabGroup', async () => service.organizeCurrentGroup()),
  );
  return service;
}
