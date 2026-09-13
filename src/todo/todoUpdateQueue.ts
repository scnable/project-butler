/**
 * 按文件键合并待执行增量更新，分批且限制并发，避免文件监听事件连续触发大量读取。
 * 尚未执行的同键任务以后一次为准；处理期间的新事件仍需留给后续批次，不能在完成时顺手清掉。
 * 此队列不替代 registerTodo 的全量刷新串行控制；dispose 清理待执行任务，但不强制中断已经运行的 Promise。
 */
export interface TodoUpdateQueueOptions {
  readonly delayMs?: number;
  readonly batchDelayMs?: number;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly onError?: (key: string, error: unknown) => void;
}

interface PendingUpdate<T> {
  readonly key: string;
  readonly value: T;
  readonly priority: number;
  readonly sequence: number;
}

/** 合并同一资源的重复事件，并以有界批次在后台处理。 */
export class TodoUpdateQueue<T> {
  private readonly pending = new Map<string, PendingUpdate<T>>();
  private readonly idleResolvers = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private processing = false;
  private disposed = false;
  private sequence = 0;

  public constructor(
    private readonly processUpdate: (key: string, value: T) => Promise<void>,
    private readonly options: TodoUpdateQueueOptions = {},
  ) {}

  public enqueue(key: string, value: T, priority = 0): void {
    if (this.disposed) return;
    this.pending.set(key, { key, value, priority, sequence: ++this.sequence });
    this.schedule(priority > 0 ? 0 : this.options.delayMs ?? 120);
  }

  public async whenIdle(): Promise<void> {
    if (!this.processing && this.timer === undefined && this.pending.size === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.add(resolve));
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.resolveIdle();
  }

  private schedule(delay: number): void {
    if (this.processing || this.timer !== undefined || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, delay);
  }

  private async drain(): Promise<void> {
    if (this.processing || this.disposed) return;
    this.processing = true;
    try {
      const batch = [...this.pending.values()]
        .sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)
        .slice(0, this.options.batchSize ?? 8);
      for (const item of batch) this.pending.delete(item.key);
      await this.runBatch(batch);
    } finally {
      this.processing = false;
      if (this.pending.size > 0) this.schedule(this.options.batchDelayMs ?? 50);
      else this.resolveIdle();
    }
  }

  private async runBatch(batch: readonly PendingUpdate<T>[]): Promise<void> {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batch.length) {
        const item = batch[cursor];
        cursor += 1;
        if (item === undefined) return;
        try {
          await this.processUpdate(item.key, item.value);
        } catch (error) {
          this.options.onError?.(item.key, error);
        }
      }
    };
    const concurrency = Math.max(1, Math.min(this.options.concurrency ?? 2, batch.length));
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  private resolveIdle(): void {
    if (this.processing || this.timer !== undefined || this.pending.size > 0) return;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers.clear();
  }
}
