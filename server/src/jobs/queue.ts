import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { logger } from '../logger.js';
import { runPayrollJob } from './processor.js';

export interface PayrollQueue {
  readonly driver: 'memory' | 'bullmq';
  enqueue(jobId: string, organizationId: string): Promise<void>;
  /** Starts consuming jobs in this process. */
  startWorker(): Promise<void>;
  /** Stops accepting work and waits for in-flight jobs, up to `timeoutMs`. */
  shutdown(timeoutMs?: number): Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 15_000;

/**
 * In-process queue: no infrastructure, adequate for a single node. Queued jobs
 * are lost on restart, which is survivable because the uploaded file is stored
 * in the database and any job can be re-triggered from the UI.
 */
class InProcessQueue implements PayrollQueue {
  readonly driver = 'memory' as const;
  private readonly waiting: string[] = [];
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly abort = new AbortController();
  private accepting = true;

  constructor(
    private readonly db: Db,
    private readonly maxParallelJobs: number,
  ) {}

  async enqueue(jobId: string): Promise<void> {
    if (!this.accepting) throw new Error('the queue is shutting down');
    await this.db.query(`UPDATE jobs SET status = 'queued', queued_at = now() WHERE id = $1`, [jobId]);
    this.waiting.push(jobId);
    queueMicrotask(() => this.drain());
  }

  async startWorker(): Promise<void> {
    // Jobs are consumed inline by drain(); nothing to start.
  }

  private drain(): void {
    while (this.accepting && this.running.size < this.maxParallelJobs && this.waiting.length) {
      const jobId = this.waiting.shift()!;
      const run = runPayrollJob({ db: this.db, jobId, signal: this.abort.signal })
        .catch((error) => logger.error({ err: error, jobId }, 'payroll job failed'))
        .finally(() => {
          this.running.delete(jobId);
          this.drain();
        });
      this.running.set(jobId, run);
    }
  }

  async shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.accepting = false;
    if (!this.running.size) return;

    logger.info({ jobs: this.running.size }, 'waiting for in-flight payroll jobs');
    const finished = await Promise.race([
      Promise.allSettled([...this.running.values()]).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);

    if (!finished) {
      // Stop the worker pools mid-row; the job is left in `processing` and can
      // be re-triggered, which is better than holding the process open.
      this.abort.abort();
      logger.warn({ jobs: this.running.size }, 'shutdown timed out, aborting in-flight jobs');
    }
  }
}

/** Redis-backed queue: durable and consumable by separate worker processes. */
class BullQueue implements PayrollQueue {
  readonly driver = 'bullmq' as const;
  private queue: import('bullmq').Queue | null = null;
  private worker: import('bullmq').Worker | null = null;
  private connection: import('ioredis').Redis | null = null;

  constructor(
    private readonly db: Db,
    private readonly maxParallelJobs: number,
  ) {}

  private async redis() {
    if (!this.connection) {
      const { default: Redis } = await import('ioredis');
      this.connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    }
    return this.connection;
  }

  async enqueue(jobId: string, organizationId: string): Promise<void> {
    if (!this.queue) {
      const { Queue } = await import('bullmq');
      this.queue = new Queue(config.queueName, { connection: await this.redis() });
    }
    await this.db.query(`UPDATE jobs SET status = 'queued', queued_at = now() WHERE id = $1`, [jobId]);
    await this.queue.add(
      'payroll-job',
      { jobId, organizationId },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
  }

  async startWorker(): Promise<void> {
    if (this.worker) return;
    const { Worker } = await import('bullmq');
    this.worker = new Worker(
      config.queueName,
      async (job) => {
        await runPayrollJob({ db: this.db, jobId: job.data.jobId });
      },
      { connection: await this.redis(), concurrency: this.maxParallelJobs },
    );
    this.worker.on('failed', (job, error) =>
      logger.error({ err: error, jobId: job?.data?.jobId }, 'payroll job failed'),
    );
    logger.info({ queue: config.queueName, concurrency: this.maxParallelJobs }, 'payroll worker started');
  }

  async shutdown(): Promise<void> {
    // BullMQ's close() waits for active jobs to finish before resolving.
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit();
  }
}

let queue: PayrollQueue | null = null;

export function getPayrollQueue(db: Db): PayrollQueue {
  if (!queue) {
    queue = config.redisUrl
      ? new BullQueue(db, config.maxParallelJobs)
      : new InProcessQueue(db, config.maxParallelJobs);
    logger.info({ driver: queue.driver }, 'payroll queue ready');
  }
  return queue;
}

export async function shutdownQueue(): Promise<void> {
  await queue?.shutdown();
  queue = null;
}
