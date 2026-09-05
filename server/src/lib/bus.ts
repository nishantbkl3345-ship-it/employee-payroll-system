import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { logger } from '../logger.js';

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
  at?: string;
  [k: string]: unknown;
}

const CHANNEL = 'payroll:events';

/**
 * Process-local event bus, transparently fanned out over Redis pub/sub when a
 * Redis URL is configured — so a job running in the worker container still
 * pushes live progress to WebSocket clients attached to the API container.
 */
class Bus extends EventEmitter {
  private publisher: any = null;
  private subscriber: any = null;
  private ready: Promise<void> | null = null;

  async connect(): Promise<void> {
    if (!config.redisUrl || this.ready) return this.ready ?? undefined;
    this.ready = (async () => {
      const { default: Redis } = await import('ioredis');
      this.publisher = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
      this.subscriber = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
      await this.subscriber.subscribe(CHANNEL);
      this.subscriber.on('message', (_channel: string, payload: string) => {
        try {
          super.emit('job', JSON.parse(payload) as JobEvent);
        } catch (err) {
          logger.warn({ err }, 'failed to decode bus message');
        }
      });
      logger.info('event bus attached to Redis pub/sub');
    })();
    return this.ready;
  }

  publish(event: JobEvent): void {
    const enriched = { ...event, at: event.at ?? new Date().toISOString() };
    if (this.publisher) {
      this.publisher.publish(CHANNEL, JSON.stringify(enriched)).catch((err: Error) => {
        logger.warn({ err }, 'bus publish failed');
      });
    } else {
      super.emit('job', enriched);
    }
  }

  onJob(handler: (event: JobEvent) => void): () => void {
    this.on('job', handler);
    return () => this.off('job', handler);
  }

  async close(): Promise<void> {
    await this.publisher?.quit?.().catch(() => {});
    await this.subscriber?.quit?.().catch(() => {});
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);
