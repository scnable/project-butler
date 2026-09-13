/**
 * TODO 的内存数据集合，供扫描器写入、视图和装饰读取；不负责扫描文件或保存用户配置。
 * 修订号用于区分全量扫描开始前后的更改，防止旧扫描把刚添加的标记抹掉或把刚删除的标记恢复。
 * 无匹配的文件也可能需要保留修订记录；修改删除逻辑时，应同时检查 removeAtRevision 与 reconcile。
 */
import { TodoMatch, TodoResourceResult } from './todoTypes';

export interface TodoIndexSnapshot {
  readonly entries: readonly TodoResourceResult[];
  readonly revisions: readonly (readonly [string, number])[];
}

export class TodoIndex {
  private readonly entries = new Map<string, TodoResourceResult>();
  private readonly revisions = new Map<string, number>();

  public replace(
    uri: string,
    matches: readonly TodoMatch[],
    revision: number,
    relativePath: string,
    workspaceUri?: string,
  ): boolean {
    const previousRevision = this.revisions.get(uri);
    if (previousRevision !== undefined && previousRevision > revision) return false;
    this.revisions.set(uri, revision);
    if (matches.length === 0) {
      return this.entries.delete(uri);
    }
    this.entries.set(uri, {
      uri,
      matches: [...matches],
      revision,
      relativePath,
      ...(workspaceUri === undefined ? {} : { workspaceUri }),
    });
    return true;
  }

  public remove(uri: string): boolean {
    this.revisions.delete(uri);
    return this.entries.delete(uri);
  }

  public removeAtRevision(uri: string, revision: number): boolean {
    const previousRevision = this.revisions.get(uri);
    if (previousRevision !== undefined && previousRevision > revision) return false;
    this.revisions.set(uri, revision);
    return this.entries.delete(uri);
  }

  public clear(): void {
    this.entries.clear();
    this.revisions.clear();
  }

  public snapshot(): TodoIndexSnapshot {
    return {
      entries: this.values().map((entry) => ({ ...entry, matches: [...entry.matches] })),
      revisions: [...this.revisions.entries()],
    };
  }

  public restore(snapshot: TodoIndexSnapshot): void {
    this.clear();
    for (const entry of snapshot.entries) {
      this.entries.set(entry.uri, { ...entry, matches: [...entry.matches] });
    }
    for (const [uri, revision] of snapshot.revisions) this.revisions.set(uri, revision);
  }

  /**
   * 原子应用一次完整扫描结果，同时保留扫描开始后产生的实时文档修订。
   */
  public reconcile(snapshot: TodoIndexSnapshot, scanRevision: number): void {
    const currentEntries = new Map(this.entries);
    const currentRevisions = new Map(this.revisions);

    this.entries.clear();
    this.revisions.clear();
    for (const entry of snapshot.entries) {
      this.entries.set(entry.uri, { ...entry, matches: [...entry.matches] });
    }
    for (const [uri, revision] of snapshot.revisions) this.revisions.set(uri, revision);

    for (const [uri, revision] of currentRevisions) {
      if (revision <= scanRevision) continue;
      this.revisions.set(uri, revision);
      const currentEntry = currentEntries.get(uri);
      if (currentEntry === undefined) this.entries.delete(uri);
      else this.entries.set(uri, { ...currentEntry, matches: [...currentEntry.matches] });
    }
  }

  public get(uri: string): TodoResourceResult | undefined {
    return this.entries.get(uri);
  }

  public values(): TodoResourceResult[] {
    return [...this.entries.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }));
  }

  public get size(): number {
    return this.entries.size;
  }
}
