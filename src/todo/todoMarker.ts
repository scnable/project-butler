/**
 * 处理标记的选择、插入与修改，通过 WorkspaceEdit 编辑文档，不自动替用户保存文件。
 * 已有描述候选由注册入口从个人标记索引提供；写入身份取自配置，不从 Git 提交身份推断。
 * 编辑成功后的即时展示还依赖 registerTodo 更新当前文档索引，不能认为文本修改会自动同步所有视图。
 */
import * as vscode from 'vscode';
import { getTodoInsertionToken } from './todoCommentSyntax';
import { getTodoSettings } from './todoSettings';
import { normalizeTodoTagName } from './todoTags';
import { isMyTodoOwner, normalizeTodoOwner, normalizeTodoOwners } from './todoOwner';
import { findMarker } from './todoMarkerModel';
import { collectSelectableTodoDescriptions, normalizeTodoDescription, TODO_DESCRIPTION_MAX_LENGTH, todoDescriptionInputValue } from './todoDescription';

const LAST_TAG_KEY = 'projectManager.todo.lastTag';

export class TodoMarker {
  public constructor(
    private readonly state: vscode.Memento,
    private readonly getExistingDescriptions: () => readonly string[] = () => [],
  ) {}

  public async quickMark(repeatLast = false): Promise<boolean> {
    const editor = await this.getWritableEditor();
    if (editor === undefined) return false;
    const settings = getTodoSettings();
    const owner = settings.owner ?? await this.configureOwner();
    if (owner === undefined) return false;
    const tag = repeatLast
      ? normalizeTodoTagName(this.state.get<string>(LAST_TAG_KEY)) ?? settings.tags[0]?.name
      : await this.chooseTag(settings.tags.map((item) => item.name));
    if (tag === undefined) return false;
    await this.state.update(LAST_TAG_KEY, tag);
    const line = editor.document.lineAt(editor.selection.active.line);
    const existingMarker = findMarker(line.text, settings.tags.map((item) => item.name));
    const selectedText = editor.document.getText(editor.selection);
    const description = await this.requestDescription(
      existingMarker === undefined
        ? selectedText
        : this.markerDescription(line.text, existingMarker.syntaxEnd, editor.document.languageId),
      existingMarker === undefined,
    );
    if (description === undefined) return false;
    if (existingMarker !== undefined) return this.updateExistingMarker(editor, line, existingMarker, tag, description);
    const token = getTodoInsertionToken(editor.document.languageId);
    if (token === undefined) {
      await vscode.window.showWarningMessage(`当前语言“${editor.document.languageId}”没有受支持的安全注释语法，未插入标记。`);
      return false;
    }
    const indent = /^\s*/.exec(line.text)?.[0] ?? '';
    const suffix = token.close.length === 0 ? '' : ` ${token.close}`;
    const text = `${indent}${token.open} ${tag}(${owner}): ${description}${suffix}${editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'}`;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(editor.document.uri, new vscode.Position(line.lineNumber, 0), text);
    return vscode.workspace.applyEdit(edit);
  }

  public async changeMark(forcedTag?: string): Promise<boolean> {
    const editor = await this.getWritableEditor();
    if (editor === undefined) return false;
    const tags = getTodoSettings().tags.map((item) => item.name);
    const line = editor.document.lineAt(editor.selection.active.line);
    const marker = findMarker(line.text, tags);
    if (marker === undefined) return this.quickMark(false);
    const tag = normalizeTodoTagName(forcedTag) ?? await this.chooseTag(tags);
    if (tag === undefined || tag === marker.tag) return false;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(editor.document.uri, new vscode.Range(line.lineNumber, marker.tagStart, line.lineNumber, marker.tagEnd), tag);
    await this.state.update(LAST_TAG_KEY, tag);
    return vscode.workspace.applyEdit(edit);
  }

  public async toggleCompleted(): Promise<boolean> {
    const editor = await this.getWritableEditor();
    if (editor === undefined) return false;
    const line = editor.document.lineAt(editor.selection.active.line);
    const marker = findMarker(line.text, getTodoSettings().tags.map((item) => item.name));
    if (marker === undefined) return false;
    const edit = new vscode.WorkspaceEdit();
    if (marker.completedRange !== undefined) {
      edit.delete(editor.document.uri, new vscode.Range(line.lineNumber, marker.completedRange.start, line.lineNumber, marker.completedRange.end));
    } else {
      edit.insert(editor.document.uri, new vscode.Position(line.lineNumber, marker.qualifierEnd), ' [x]');
    }
    return vscode.workspace.applyEdit(edit);
  }

  public async removeMark(): Promise<boolean> {
    const editor = await this.getWritableEditor();
    if (editor === undefined) return false;
    const line = editor.document.lineAt(editor.selection.active.line);
    const marker = findMarker(line.text, getTodoSettings().tags.map((item) => item.name));
    if (marker === undefined) return false;
    const edit = new vscode.WorkspaceEdit();
    edit.delete(editor.document.uri, new vscode.Range(line.lineNumber, marker.tagStart, line.lineNumber, marker.syntaxEnd));
    return vscode.workspace.applyEdit(edit);
  }

  public async configureOwner(): Promise<string | undefined> {
    const settings = getTodoSettings();
    const value = await vscode.window.showInputBox({
      title: '设置个人标记标识',
      prompt: '用于生成 TODO(标识)；允许字母、数字、点、下划线和连字符，最多 32 个字符。该标识会写入源码。',
      value: settings.owner ?? '',
      validateInput(input) { return normalizeTodoOwner(input) === undefined ? '请输入有效的个人标记标识。' : undefined; },
    });
    const owner = normalizeTodoOwner(value);
    if (owner === undefined) return undefined;
    if (settings.owner !== undefined && settings.owner.toLocaleLowerCase() !== owner.toLocaleLowerCase()) {
      const aliases = normalizeTodoOwners(undefined, [...settings.ownerAliases, settings.owner]);
      await vscode.workspace.getConfiguration('projectManager.todo').update('ownerAliases', aliases, vscode.ConfigurationTarget.Global);
    }
    await vscode.workspace.getConfiguration('projectManager.todo').update('owner', owner, vscode.ConfigurationTarget.Global);
    return owner;
  }

  public async assignToMe(): Promise<boolean> {
    const editor = await this.getWritableEditor();
    if (editor === undefined) return false;
    const owner = getTodoSettings().owner ?? await this.configureOwner();
    if (owner === undefined) return false;
    const line = editor.document.lineAt(editor.selection.active.line);
    const marker = findMarker(line.text, getTodoSettings().tags.map((item) => item.name));
    if (marker === undefined || marker.owner?.toLocaleLowerCase() === owner.toLocaleLowerCase()) return false;
    const edit = new vscode.WorkspaceEdit();
    if (marker.ownerRange !== undefined) {
      edit.replace(editor.document.uri, new vscode.Range(line.lineNumber, marker.ownerRange.start, line.lineNumber, marker.ownerRange.end), owner);
    } else {
      edit.insert(editor.document.uri, new vscode.Position(line.lineNumber, marker.tagEnd), `(${owner})`);
    }
    return vscode.workspace.applyEdit(edit);
  }

  public async unassignMine(): Promise<boolean> {
    const editor = await this.getWritableEditor();
    if (editor === undefined) return false;
    const settings = getTodoSettings();
    const line = editor.document.lineAt(editor.selection.active.line);
    const marker = findMarker(line.text, settings.tags.map((item) => item.name));
    if (marker?.ownerSyntaxRange === undefined || !isMyTodoOwner(marker.owner, settings.ownerIdentities)) return false;
    const edit = new vscode.WorkspaceEdit();
    edit.delete(editor.document.uri, new vscode.Range(
      line.lineNumber, marker.ownerSyntaxRange.start,
      line.lineNumber, marker.ownerSyntaxRange.end,
    ));
    return vscode.workspace.applyEdit(edit);
  }

  private async chooseTag(tags: readonly string[]): Promise<string | undefined> {
    const selected = await vscode.window.showQuickPick(tags, { title: '快速标记：选择关键词', placeHolder: '选择要插入的注释关键词' });
    return normalizeTodoTagName(selected);
  }

  private async requestDescription(seed: string, allowExistingSelection: boolean): Promise<string | undefined> {
    if (allowExistingSelection) {
      const existing = collectSelectableTodoDescriptions(this.getExistingDescriptions());
      if (existing.length > 0) {
        type DescriptionChoice = vscode.QuickPickItem & { readonly value?: string };
        const choices: DescriptionChoice[] = [
          {
            label: '$(edit) 输入新描述',
            ...(seed.trim().length === 0 ? {} : { description: '已用选中文本预填' }),
          },
          ...existing.map((value) => ({ label: value, description: '已有描述', value })),
        ];
        const selected = await vscode.window.showQuickPick(choices, {
          title: '快速标记：选择或新建任务描述',
          placeHolder: '复用当前个人标记的描述，或输入新描述',
        });
        if (selected === undefined) return undefined;
        if (selected.value !== undefined) return selected.value;
      }
    }
    const value = await vscode.window.showInputBox({
      title: '快速标记：填写任务描述',
      prompt: `例如“添加账号设置功能”或“修改连接超时问题”，最多 ${TODO_DESCRIPTION_MAX_LENGTH} 个字符。`,
      value: todoDescriptionInputValue(seed),
      validateInput(input) {
        if (input.replace(/\s+/g, ' ').trim().length === 0) return '请填写任务描述。';
        if ([...input.replace(/\s+/g, ' ').trim()].length > TODO_DESCRIPTION_MAX_LENGTH) return `任务描述不能超过 ${TODO_DESCRIPTION_MAX_LENGTH} 个字符。`;
        return undefined;
      },
    });
    return normalizeTodoDescription(value);
  }

  private markerDescription(line: string, syntaxEnd: number, languageId: string): string {
    const close = this.markerClosingToken(line, languageId);
    let value = line.slice(syntaxEnd).trim();
    if (close.length > 0 && value.endsWith(close)) {
      value = value.slice(0, -close.length).trimEnd();
    }
    return value;
  }

  private markerClosingToken(line: string, languageId: string): string {
    const configured = getTodoInsertionToken(languageId)?.close ?? '';
    if (configured.length > 0) return configured;
    const trimmed = line.trimEnd();
    if (trimmed.endsWith('-->')) return '-->';
    if (trimmed.endsWith('*/')) return '*/';
    return '';
  }

  private async updateExistingMarker(
    editor: vscode.TextEditor,
    line: vscode.TextLine,
    marker: NonNullable<ReturnType<typeof findMarker>>,
    tag: string,
    description: string,
  ): Promise<boolean> {
    const currentDescription = this.markerDescription(line.text, marker.syntaxEnd, editor.document.languageId);
    if (tag === marker.tag && description === currentDescription) return false;
    const close = this.markerClosingToken(line.text, editor.document.languageId);
    const trimmedEnd = line.text.trimEnd().length;
    const hasClosingToken = close.length > 0 && line.text.slice(0, trimmedEnd).endsWith(close);
    const replacement = hasClosingToken ? `${description} ${close}` : description;
    const edit = new vscode.WorkspaceEdit();
    if (tag !== marker.tag) {
      edit.replace(editor.document.uri, new vscode.Range(line.lineNumber, marker.tagStart, line.lineNumber, marker.tagEnd), tag);
    }
    edit.replace(editor.document.uri, new vscode.Range(line.lineNumber, marker.syntaxEnd, line.lineNumber, line.text.length), replacement);
    await this.state.update(LAST_TAG_KEY, tag);
    return vscode.workspace.applyEdit(edit);
  }

  private async getWritableEditor(): Promise<vscode.TextEditor | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      await vscode.window.showInformationMessage('请先打开可编辑的文本文件。');
      return undefined;
    }
    if (vscode.workspace.fs.isWritableFileSystem(editor.document.uri.scheme) === false) {
      await vscode.window.showWarningMessage('当前文档提供器是只读的，不能写入 TODO 标记。');
      return undefined;
    }
    return editor;
  }
}
