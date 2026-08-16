import * as vscode from 'vscode';
import { ExclusionServiceV2 } from '../exclusions/exclusionServiceV2';
import { ExternalFileMonitor } from '../externalFiles/externalFileMonitor';
import { RegisteredProjectCatalogV2 } from '../projectCatalog/registerProjectCatalogV2';
import { SymbolOutlineViewProvider } from '../symbolOutline/symbolOutlineViewProvider';
import { TabManagementService } from '../tabManagement/tabManagementService';
import { RegisteredOpenedFilesTree } from '../tabManagement/registerOpenedFilesTree';

/**
 * 扩展激活后返回的内部 API。生产功能不依赖此接口；集成测试使用它读取真实服务状态，
 * 避免通过不稳定的像素级桌面自动化猜测结果。
 */
export interface ProjectButlerApi {
  readonly context: vscode.ExtensionContext;
  readonly output: vscode.OutputChannel;
  readonly exclusions: ExclusionServiceV2;
  readonly externalFiles: ExternalFileMonitor;
  readonly catalogs: RegisteredProjectCatalogV2;
  readonly tabs: TabManagementService;
  readonly openedFilesTree: RegisteredOpenedFilesTree;
  readonly outline: SymbolOutlineViewProvider;
}
