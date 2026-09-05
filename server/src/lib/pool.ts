import { sleep } from './sleep.js';

export interface PoolOptions {
  /** Number of tasks executed in parallel. */
  concurrency: number;
  /** Attempts per task before it is recorded as a failure. */
  maxAttempts?: number;
  /** Base delay for exponential backoff between retries. */
  retryBaseMs?: number;
  /** Called after each task settles. Keep it cheap — it runs `items.length` times. */
  onSettled?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface PoolFailure {
  index: number;
  attempts: number;
  error: Error;
}

export interface PoolResult<R> {
  /** Positionally aligned with the input; `undefined` where the task failed. */
  results: Array<R | undefined>;
  failures: PoolFailure[];
  durationMs: number;
  attempts: number;
  concurrency: number;
}

/**
 * A fixed-size worker pool over an array of tasks.
 *
 * `concurrency` workers pull from a shared cursor, so a slow task never blocks
 * the queue behind it (unlike chunked `Promise.all` batching, where every batch
 * runs at the speed of its slowest member). Each task gets bounded retries with
 * exponential backoff; permanent failures are collected rather than thrown, so
 * one bad row can never take the whole job down.
 */
export async function runPool<T, R>(
  items: readonly T[],
  handler: (item: T, index: number) => Promise<R>,
  opts: PoolOptions,
): Promise<PoolResult<R>> {
  const total = items.length;
  const concurrency = Math.max(1, Math.min(Math.floor(opts.concurrency) || 1, total || 1));
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 1);
  const retryBaseMs = opts.retryBaseMs ?? 10;

  const results: Array<R | undefined> = new Array(total);
  const failures: PoolFailure[] = [];
  const startedAt = performance.now();

  let cursor = 0;
  let done = 0;
  let attemptCount = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const index = cursor++;
      if (index >= total) return;

      let attempts = 0;
      for (;;) {
        attempts++;
        attemptCount++;
        try {
          results[index] = await handler(items[index], index);
          break;
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          if (attempts >= maxAttempts || opts.signal?.aborted) {
            failures.push({ index, attempts, error });
            break;
          }
          await sleep(retryBaseMs * 2 ** (attempts - 1));
        }
      }

      done++;
      opts.onSettled?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  return {
    results,
    failures,
    durationMs: performance.now() - startedAt,
    attempts: attemptCount,
    concurrency,
  };
}
