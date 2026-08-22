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
