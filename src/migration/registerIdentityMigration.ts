import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import {
  OLD_EXTENSION_ID, NEW_EXTENSION_ID, MIGRATION_MAX_BYTES, createIdentityMigration,
  parseIdentityMigration, assertMigrationNoConflicts, stageIdentityMigration, applyPendingIdentityMigration,
} from './identityMigration';

const roots = (): string[] => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString());

/** 必须在集合、屏蔽和 TODO 初始化前执行，避免旧内存对象覆盖已导入状态。 */
export async function initializeIdentityMigration(context: vscode.ExtensionContext): Promise<void> {
  const otherId = context.extension.id === OLD_EXTENSION_ID ? NEW_EXTENSION_ID : OLD_EXTENSION_ID;
  if (vscode.extensions.getExtension(otherId) !== undefined) {
    throw new Error('旧版与正式版不能同时启用。请停用另一版本并重载窗口后继续。');
  }
  if (context.extension.id === NEW_EXTENSION_ID) {
    try { await applyPendingIdentityMigration(roots(), context.globalState, context.workspaceState); }
    catch (error) {
      await vscode.window.showErrorMessage('迁移未完成，已保留迁移记录。本次不启动功能，请检查工作区或数据冲突。', { modal: true });
      throw error;
    }
  }
}

export function registerIdentityMigration(context: vscode.ExtensionContext, ready: Promise<void>): void {
  let busy = false;
  const run = async (task: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    try { await ready; await task(); }
    catch (error) {
      const message = error instanceof Error && error.message.startsWith('已有状态') ? error.message
        : '迁移操作未完成：请检查文件格式、工作区是否一致，以及目标文件是否已存在。';
      await vscode.window.showErrorMessage(message, { modal: true });
    } finally { busy = false; }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('projectManager.exportIdentityMigration', () => run(async () => {
      if (context.extension.id !== OLD_EXTENSION_ID) {
        await vscode.window.showInformationMessage('此命令只用于旧身份过渡版导出；正式版管理集合请使用集合导出。'); return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        '导出文件包含项目路径和恢复记录，请勿上传或提交到仓库。每个需要保留恢复记录的工作区应分别导出。',
        { modal: true }, '选择保存位置');
      if (confirmed !== '选择保存位置') return;
      const destination = await vscode.window.showSaveDialog({ title: '导出到正式版迁移文件',
        filters: { 'CAtlas Hub 迁移文件': ['catlas-migration.json'] } });
      if (!destination) return;
      if (destination.scheme !== 'file') throw new Error('迁移导出仅支持本机文件路径。');
      const text = createIdentityMigration(context.globalState, context.workspaceState, roots());
      // wx 保证不覆盖任何已有文件，包括用户在对话框中选中的同名文件。
      await writeFile(destination.fsPath, text, { encoding: 'utf8', flag: 'wx' });
      await vscode.window.showInformationMessage('迁移文件已导出。请停用旧版并重载窗口，再安装正式身份版本。');
    })),
    vscode.commands.registerCommand('projectManager.importIdentityMigration', () => run(async () => {
      if (context.extension.id !== NEW_EXTENSION_ID) {
        await vscode.window.showInformationMessage('请在 scnable.catlas-hub 中导入迁移文件。'); return;
      }
      const selection = await vscode.window.showOpenDialog({ title: '导入旧身份迁移文件', canSelectMany: false,
        filters: { 'CAtlas Hub 迁移文件': ['catlas-migration.json'] } });
      const source = selection?.[0];
      if (!source) return;
      const stat = await vscode.workspace.fs.stat(source);
      if (stat.type !== vscode.FileType.File || stat.size > MIGRATION_MAX_BYTES) throw new Error('迁移文件无效。');
      const bytes = await vscode.workspace.fs.readFile(source);
      if (bytes.byteLength > MIGRATION_MAX_BYTES) throw new Error('迁移文件超过大小限制。');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed = parseIdentityMigration(text, roots());
      const confirmed = await vscode.window.showWarningMessage(
        `旧版文件含 ${Object.keys(parsed.global).length} 项全局状态、${Object.keys(parsed.workspace).length} 项当前工作区状态。只补充不存在的值，冲突时拒绝导入；重载后生效。已在其他工作区迁移集合时可仅导入当前工作区。请只导入你信任的文件。`,
        { modal: true }, '导入全部状态', '仅导入当前工作区');
      if (confirmed !== '导入全部状态' && confirmed !== '仅导入当前工作区') return;
      const data = confirmed === '仅导入当前工作区' ? { ...parsed, global: {} } : parsed;
      assertMigrationNoConflicts(data, context.globalState, context.workspaceState);
      await stageIdentityMigration(JSON.stringify(data), roots(), context.globalState, context.workspaceState);
      const reload = await vscode.window.showInformationMessage('迁移已暂存。请立即重载，不要继续编辑集合或屏蔽设置；暂存文件包含路径，请注意隐私。',
        { modal: true }, '重载窗口');
      if (reload === '重载窗口') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    })),
  );
}
