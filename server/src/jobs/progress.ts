import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { logger } from '../logger.js';

export type PipelineStage =
  | 'parsing'
  | 'validating'
  | 'resolving'
  | 'overtime'
  | 'persisting'
  | 'aggregating';

export interface JobEvent {
  type: 'job.progress' | 'job.status' | 'job.log';
  jobId: string;
  orgId: string;
  correlationId?: string;
  status?: string;
  stage?: string;
  processedRows?: number;
  totalRows?: number;
  percent?: number;
  message?: string;
  level?: string;
  event?: string;
  at?: string;
}

const REDIS_CHANNEL = 'payroll:job-events';

/**
 * Job events, fanned out over Redis pub/sub when it is configured so a job
 * running in the worker container still reaches WebSocket clients attached to
 * the API container.
 */
class JobEventChannel extends EventEmitter {
  private publisher: { publish(channel: string, message: string): Promise<unknown>; quit(): Promise<unknown> } | null =
    null;
  private subscriber: { subscribe(channel: string): Promise<unknown>; quit(): Promise<unknown> } | null = null;
  private connecting: Promise<void> | null = null;

  connect(): Promise<void> {
    if (!config.redisUrl) return Promise.resolve();
    this.connecting ??= this.connectToRedis();
    return this.connecting;
  }

  private async connectToRedis(): Promise<void> {
    const { default: Redis } = await import('ioredis');
    this.publisher = new Redis(config.redisUrl, { maxRetriesPerRequest: null }) as never;
    const subscriber = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    await subscriber.subscribe(REDIS_CHANNEL);
    subscriber.on('message', (_channel, message) => {
      try {
        super.emit('event', JSON.parse(message) as JobEvent);
      } catch (error) {
        logger.warn({ err: error }, 'discarded malformed job event from Redis');
      }
    });
    this.subscriber = subscriber as never;
    logger.info('job events attached to Redis pub/sub');
  }

  publish(event: JobEvent): void {
    const enriched = { ...event, at: event.at ?? new Date().toISOString() };
    if (!this.publisher) {
      super.emit('event', enriched);
      return;
    }
    this.publisher.publish(REDIS_CHANNEL, JSON.stringify(enriched)).catch((error: Error) => {
      logger.warn({ err: error, jobId: event.jobId }, 'failed to publish job event');
    });
  }

  subscribe(handler: (event: JobEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.publisher?.quit(), this.subscriber?.quit()]);
  }
}

export const jobEvents = new JobEventChannel();
jobEvents.setMaxListeners(0);

/** Percentage band each pipeline stage occupies, so the UI has one number. */
const STAGE_RANGE: Record<PipelineStage, [number, number]> = {
  parsing: [0, 5],
  validating: [5, 70],
  resolving: [70, 80],
  overtime: [80, 88],
  persisting: [88, 95],
  aggregating: [95, 100],
};

const PROGRESS_INTERVAL_MS = 200;

export interface ProgressReporter {
  (stage: PipelineStage, done: number, total: number): void;
  flush(stage: PipelineStage): void;
}

/**
 * Publishes progress for one job. Updates are throttled because the validating
 * stage settles once per row — writing 10,000 rows of progress to the database
 * would cost more than the work being reported on.
 */
export function createProgressReporter(
  db: Db,
  job: { id: string; org_id: string; correlation_id: string },
): ProgressReporter {
  let lastPublishedAt = 0;
  let lastProcessedRows = 0;

  function publish(stage: PipelineStage, done: number, total: number, force: boolean): void {
    const [from, to] = STAGE_RANGE[stage];
    const percent = Math.round(total > 0 ? from + (done / total) * (to - from) : to);

    const now = Date.now();
    if (!force && now - lastPublishedAt < PROGRESS_INTERVAL_MS) return;
    lastPublishedAt = now;

    if (stage === 'validating') lastProcessedRows = done;

    jobEvents.publish({
      type: 'job.progress',
      jobId: job.id,
      orgId: job.org_id,
      correlationId: job.correlation_id,
      status: 'processing',
      stage,
      processedRows: lastProcessedRows,
      totalRows: total,
      percent,
    });

    db.query('UPDATE jobs SET stage = $2, processed_rows = $3 WHERE id = $1', [
      job.id,
      stage,
      lastProcessedRows,
    ]).catch((error) => logger.debug({ err: error, jobId: job.id }, 'progress update failed'));
  }

  const report = ((stage, done, total) => publish(stage, done, total, false)) as ProgressReporter;
  report.flush = (stage: PipelineStage) => publish(stage, 1, 1, true);
  return report;
}
