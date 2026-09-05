import { describe, expect, it } from 'vitest';
import { runWorkerPool, sleep } from '../src/jobs/workerPool.js';

describe('worker pool', () => {
  it('processes tasks concurrently rather than sequentially', async () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    const delay = 20;

    const started = Date.now();
    const out = await runWorkerPool(items, async (i) => {
      await sleep(delay);
      return i * 2;
    }, { concurrency: 8 });
    const elapsed = Date.now() - started;

    expect(out.results).toEqual(items.map((i) => i * 2));
    // Sequential would be 40 * 20ms = 800ms; with 8 workers expect ~100ms.
    expect(elapsed).toBeLessThan(500);
  });

  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    await runWorkerPool(
      Array.from({ length: 50 }, (_, i) => i),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight--;
      },
      { concurrency: 4 },
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('retries a flaky task and then succeeds', async () => {
    const attempts = new Map<number, number>();
    const out = await runWorkerPool(
      [0, 1, 2],
      async (i) => {
        const n = (attempts.get(i) ?? 0) + 1;
        attempts.set(i, n);
        if (i === 1 && n < 3) throw new Error('transient');
        return i;
      },
      { concurrency: 2, maxAttempts: 3, retryBaseMs: 1 },
    );
    expect(out.failures).toHaveLength(0);
    expect(attempts.get(1)).toBe(3);
  });

  it('isolates a permanently failing task instead of rejecting the run', async () => {
    const out = await runWorkerPool(
      [0, 1, 2, 3],
      async (i) => {
        if (i === 2) throw new Error('always broken');
        return i;
      },
      { concurrency: 2, maxAttempts: 2, retryBaseMs: 1 },
    );
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].index).toBe(2);
    expect(out.results[3]).toBe(3);
  });

  it('reports progress once per settled task', async () => {
    const seen: number[] = [];
    await runWorkerPool([1, 2, 3, 4, 5], async (x) => x, {
      concurrency: 2,
      onSettled: (done) => seen.push(done),
    });
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });
});
