export const TODO_SCAN_CONCURRENCY = 8;
export const TODO_SCAN_MAX_RESULTS = 5_000;

export interface TodoScanEngineProgress {
  readonly files: number;
  readonly skippedFiles: number;
  readonly results: number;
  readonly truncated: boolean;
  readonly cancelled: boolean;
}

export interface TodoScanEngineOptions<TItem, TResult> {
  readonly items: readonly TItem[];
  readonly concurrency?: number;
  readonly maxResults?: number;
  readonly isCancelled: () => boolean;
  readonly load: (item: TItem) => Promise<readonly TResult[] | undefined>;
  readonly commit: (item: TItem, results: readonly TResult[]) => void;
  readonly onSkipped?: (item: TItem, error?: unknown) => void;
  readonly onProgress?: (progress: TodoScanEngineProgress) => void;
}

export async function runTodoScanEngine<TItem, TResult>(
  options: TodoScanEngineOptions<TItem, TResult>,
): Promise<TodoScanEngineProgress> {
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? TODO_SCAN_CONCURRENCY));
  const maxResults = Math.max(1, Math.trunc(options.maxResults ?? TODO_SCAN_MAX_RESULTS));
  let files = 0;
  let skippedFiles = 0;
  let results = 0;
  let nextIndex = 0;
  let truncated = false;

  const progress = (): TodoScanEngineProgress => ({
    files,
    skippedFiles,
    results,
    truncated,
    cancelled: options.isCancelled(),
  });
  const notify = (): void => options.onProgress?.(progress());

  const worker = async (): Promise<void> => {
    while (!options.isCancelled() && !truncated) {
      const index = nextIndex;
      nextIndex += 1;
      const item = options.items[index];
      if (item === undefined) return;

      let loaded: readonly TResult[] | undefined;
      try {
        loaded = await options.load(item);
      } catch (error) {
        skippedFiles += 1;
        options.onSkipped?.(item, error);
        notify();
        continue;
      }
      if (options.isCancelled()) return;
      if (loaded === undefined) {
        skippedFiles += 1;
        options.onSkipped?.(item);
        notify();
        continue;
      }

      const remaining = maxResults - results;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const accepted = loaded.slice(0, remaining);
      if (accepted.length < loaded.length) truncated = true;
      options.commit(item, accepted);
      files += 1;
      results += accepted.length;
      if (results >= maxResults && nextIndex < options.items.length) truncated = true;
      notify();
    }
  };

  const workerCount = Math.min(concurrency, options.items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return progress();
}
