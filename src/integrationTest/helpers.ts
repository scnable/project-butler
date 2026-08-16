import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { CatalogLibrary, StoredProjectCatalog, createEmptyCatalogLibrary, createStoredCatalog, createStoredProject } from '../projectCatalog/catalogStore';
import { ProjectButlerApi } from '../testing/projectButlerApi';

const EXTENSION_ID = 'local-development.project-butler';
const LIBRARY_KEY = 'projectManager.catalogLibrary.v1';
const ACTIVE_CATALOG_ID_KEY = 'projectManager.catalogLibrary.activeId';
const LAST_ACTIVE_CATALOG_ID_KEY = 'projectManager.catalogLibrary.lastActiveId';
const PROJECT_BINDINGS_KEY = 'projectManager.catalogLibrary.projectBindings';
const RESTORE_SUPPRESSED_KEY = 'projectManager.catalogLibrary.restoreSuppressed';

let apiPromise: Promise<ProjectButlerApi> | undefined;

export async function getApi(): Promise<ProjectButlerApi> {
  apiPromise ??= activateExtension();
  return apiPromise;
}

async function activateExtension(): Promise<ProjectButlerApi> {
  const extension = vscode.extensions.getExtension<ProjectButlerApi>(EXTENSION_ID);
  assert.ok(extension, `未找到扩展：${EXTENSION_ID}`);
  const api = await extension.activate();
  await api.catalogs.initialization;
  return api;
}

export function projectUri(api: ProjectButlerApi, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(api.context.extensionUri, ...relativePath.split('/'));
}

export function currentWorkspaceUri(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, '当前测试需要工作区');
  return folder.uri;
}

export function createCatalogForWorkspace(
  name = '集成测试集合',
  options: { readonly autoOrganize?: boolean; readonly outlineMode?: 'native' | 'enhanced' | 'both' } = {},
): StoredProjectCatalog {
  const workspace = currentWorkspaceUri();
  const catalog = createStoredCatalog(name, [{
    alias: '工作区一',
    uri: workspace.toString(),
    type: 'folder',
    description: '集成测试项目',
    tags: ['integration', 'workspace-one'],
  }]);
  return {
    ...catalog,
    features: {
      tabs: { autoOrganize: options.autoOrganize ?? false },
      symbolOutline: { mode: options.outlineMode ?? 'both' },
    },
  };
}

export function appendProject(
  catalog: StoredProjectCatalog,
  alias: string,
  uri: vscode.Uri,
  type: 'folder' | 'workspace' = 'folder',
): StoredProjectCatalog {
  return {
    ...catalog,
    projects: [...catalog.projects, createStoredProject({ alias, uri: uri.toString(), type })],
  };
}

export async function seedCatalogs(
  api: ProjectButlerApi,
  catalogs: readonly StoredProjectCatalog[],
  activeId?: string,
): Promise<void> {
  const library: CatalogLibrary = { ...createEmptyCatalogLibrary(), catalogs };
  await api.catalogs.service.replaceLibraryForIntegrationTest(library, activeId);
  await delay(20);
}

export async function resetCatalogs(api: ProjectButlerApi): Promise<void> {
  await seedCatalogs(api, []);
}

export async function setGlobalSetting(section: string, key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
}

export async function setWorkspaceSetting(section: string, key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Workspace);
}

export async function closeAllEditors(): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((group) => [...group.tabs]);
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
  await delay(50);
}

export async function openText(uri: vscode.Uri, options: vscode.TextDocumentShowOptions = {}): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(document, { preview: false, ...options });
}

export function tabUris(group = vscode.window.tabGroups.activeTabGroup): string[] {
  return group.tabs.flatMap((tab) => tab.input instanceof vscode.TabInputText ? [tab.input.uri.toString()] : []);
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started >= timeoutMs) throw new Error(message);
    await delay(25);
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function stubQuickPick(
  sandbox: sinon.SinonSandbox,
  answers: readonly (unknown | ((items: readonly unknown[]) => unknown))[],
): sinon.SinonStub {
  const queue = [...answers];
  return (sandbox.stub(vscode.window, 'showQuickPick') as sinon.SinonStub).callsFake(async (items: readonly unknown[]) => {
    const answer = queue.shift();
    return typeof answer === 'function' ? answer(items) : answer;
  });
}

export function stubInputBox(sandbox: sinon.SinonSandbox, answers: readonly (string | undefined)[]): sinon.SinonStub {
  const queue = [...answers];
  return (sandbox.stub(vscode.window, 'showInputBox') as sinon.SinonStub).callsFake(async () => queue.shift());
}

export function stubInformationMessage(sandbox: sinon.SinonSandbox, answers: readonly unknown[]): sinon.SinonStub {
  const queue = [...answers];
  return (sandbox.stub(vscode.window, 'showInformationMessage') as sinon.SinonStub).callsFake(async () => queue.shift());
}

export function stubWarningMessage(sandbox: sinon.SinonSandbox, answers: readonly unknown[]): sinon.SinonStub {
  const queue = [...answers];
  return (sandbox.stub(vscode.window, 'showWarningMessage') as sinon.SinonStub).callsFake(async () => queue.shift());
}

export function stubOpenDialog(sandbox: sinon.SinonSandbox, answers: readonly (readonly vscode.Uri[] | undefined)[]): sinon.SinonStub {
  const queue = [...answers];
  return (sandbox.stub(vscode.window, 'showOpenDialog') as sinon.SinonStub).callsFake(async () => queue.shift());
}

export function stubSaveDialog(sandbox: sinon.SinonSandbox, answers: readonly (vscode.Uri | undefined)[]): sinon.SinonStub {
  const queue = [...answers];
  return (sandbox.stub(vscode.window, 'showSaveDialog') as sinon.SinonStub).callsFake(async () => queue.shift());
}
