export type TodoViewUpdateKind = 'start' | 'openFiles' | 'progress' | 'incremental' | 'complete';

export class TodoViewRefreshPolicy {
  private scanning = false;
  private openFilesPublished = false;

  public shouldRefreshTree(kind: TodoViewUpdateKind): boolean {
    switch (kind) {
      case 'start':
        this.scanning = true;
        this.openFilesPublished = false;
        return true;
      case 'openFiles':
        if (!this.scanning || this.openFilesPublished) return false;
        this.openFilesPublished = true;
        return true;
      case 'progress':
        return false;
      case 'incremental':
        return !this.scanning;
      case 'complete':
        this.scanning = false;
        return true;
    }
  }
}
