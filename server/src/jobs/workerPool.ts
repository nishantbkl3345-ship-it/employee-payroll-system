export const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export interface WorkerPoolOptions {
  concurrency: number;
  /** Attempts per task before it is recorded as a failure. Default 1. */
  maxAttempts?: number;
  retryBaseMs?: number;
  /** Runs once per settled task — keep it cheap. */
  onSettled?: (settled: number, total: number) => void;
  signal?: AbortSignal;
}

export interface TaskFailure {
  index: number;
  attempts: number;
  error: Error;
}

export interface WorkerPoolResult<T> {
  /** Aligned with the input; `undefined` where the task failed. */
  results: Array<T | undefined>;
  failures: TaskFailure[];
  durationMs: number;
  /** Total attempts including retries, for the retry metric. */
  attempts: number;
}

/**
 * Runs tasks across a fixed number of workers pulling from a shared cursor, so
 * a slow task never blocks the ones behind it — unlike chunked Promise.all,
 * where every batch runs at the speed of its slowest member.
 *
 * Failures are collected rather than thrown: one bad timesheet row must not
 * take down a payroll run of 10,000.
 */
export async function runWorkerPool<Task, Result>(
  tasks: readonly Task[],
  run: (task: Task, index: number) => Promise<Result>,
  options: WorkerPoolOptions,
): Promise<WorkerPoolResult<Result>> {
  const total = tasks.length;
  const workerCount = Math.max(1, Math.min(Math.floor(options.concurrency) || 1, total || 1));
  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
  const retryBaseMs = options.retryBaseMs ?? 10;

  const results: Array<Result | undefined> = new Array(total);
  const failures: TaskFailure[] = [];
  const startedAt = performance.now();

  let nextIndex = 0;
  let settled = 0;
  let attempts = 0;

  async function worker(): Promise<void> {
    while (!options.signal?.aborted) {
      const index = nextIndex++;
      if (index >= total) return;

      for (let attempt = 1; ; attempt++) {
        attempts++;
        try {
          results[index] = await run(tasks[index], index);
          break;
        } catch (error) {
          if (attempt >= maxAttempts || options.signal?.aborted) {
            failures.push({
              index,
              attempts: attempt,
              error: error instanceof Error ? error : new Error(String(error)),
            });
            break;
          }
          await sleep(retryBaseMs * 2 ** (attempt - 1));
        }
      }

      settled++;
      options.onSettled?.(settled, total);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));

  return { results, failures, durationMs: performance.now() - startedAt, attempts };
}
