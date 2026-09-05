import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { logger } from '../logger.js';
import { processJob } from './processor.js';

export interface JobQueue {
  readonly driver: 'memory' | 'bullmq';
  enqueue(jobId: string, orgId: string): Promise<void>;
  /** Start consuming jobs in this process. */
  startWorker(): Promise<void>;
  close(): Promise<void>;
}

/**
 * In-process queue. Zero infrastructure, survives nothing — good enough for a
 * single-node deployment and for local development, and it keeps the API
 * contract identical to the Redis-backed driver.
 */
class MemoryQueue implements JobQueue {
  readonly driver = 'memory' as const;
  private pending: string[] = [];
  private running = 0;
  private closed = false;
  private readonly maxParallelJobs = Math.max(1, Number(process.env.MAX_PARALLEL_JOBS ?? 2));

  constructor(private readonly db: Db) {}

  async enqueue(jobId: string): Promise<void> {
    await this.db.query(`UPDATE jobs SET status = 'queued', queued_at = now() WHERE id = $1`, [jobId]);
    this.pending.push(jobId);
    queueMicrotask(() => this.drain());
  }

  async startWorker(): Promise<void> {
    /* consumption happens inline via drain() */
  }

  private drain(): void {
    while (!this.closed && this.running < this.maxParallelJobs && this.pending.length) {
      const jobId = this.pending.shift()!;
      this.running++;
      processJob({ db: this.db, jobId })
        .catch((err) => logger.error({ err, jobId }, 'job failed'))
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Redis-backed queue: durable, retried, and consumable by separate worker processes. */
class BullQueue implements JobQueue {
  readonly driver = 'bullmq' as const;
  private queue: any = null;
  private worker: any = null;
  private connection: any = null;

  constructor(private readonly db: Db) {}

  private async conn() {
    if (!this.connection) {
      const { default: Redis } = await import('ioredis');
      this.connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    }
    return this.connection;
  }

  private async getQueue() {
    if (!this.queue) {
      const { Queue } = await import('bullmq');
      this.queue = new Queue(config.queueName, { connection: await this.conn() });
    }
    return this.queue;
  }

  async enqueue(jobId: string, orgId: string): Promise<void> {
    const q = await this.getQueue();
    await this.db.query(`UPDATE jobs SET status = 'queued', queued_at = now() WHERE id = $1`, [jobId]);
    await q.add(
      'process-timesheet',
      { jobId, orgId },
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
      async (job: any) => processJob({ db: this.db, jobId: job.data.jobId }),
      { connection: await this.conn(), concurrency: Number(process.env.MAX_PARALLEL_JOBS ?? 2) },
    );
    this.worker.on('failed', (job: any, err: Error) =>
      logger.error({ err, jobId: job?.data?.jobId }, 'bullmq job failed'),
    );
    this.worker.on('completed', (job: any) => logger.info({ jobId: job?.data?.jobId }, 'bullmq job completed'));
    logger.info({ queue: config.queueName }, 'BullMQ worker started');
  }

  async close(): Promise<void> {
    await this.worker?.close().catch(() => {});
    await this.queue?.close().catch(() => {});
    await this.connection?.quit().catch(() => {});
  }
}

let instance: JobQueue | null = null;

export function getQueue(db: Db): JobQueue {
  if (!instance) {
    instance = config.redisUrl ? new BullQueue(db) : new MemoryQueue(db);
    logger.info({ driver: instance.driver }, 'job queue initialised');
  }
  return instance;
}

export async function closeQueue(): Promise<void> {
  await instance?.close();
  instance = null;
}
