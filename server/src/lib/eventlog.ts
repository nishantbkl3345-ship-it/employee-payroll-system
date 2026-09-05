import type { Db } from '../db/index.js';
import { logger } from '../logger.js';
import { bus } from './bus.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface EventInput {
  orgId?: string | null;
  jobId?: string | null;
  correlationId?: string | null;
  level?: LogLevel;
  event: string;
  message?: string;
  data?: Record<string, unknown>;
  /** Also push to connected WebSocket clients. */
  broadcast?: boolean;
}

/**
 * Writes one structured event to stdout (for log shipping) and to `event_log`
 * (so the UI can show a per-job trace). Never throws: observability must not be
 * able to fail a payroll run.
 */
export async function recordEvent(db: Db, input: EventInput): Promise<void> {
  const level = input.level ?? 'info';
  const payload = {
    correlationId: input.correlationId ?? undefined,
    jobId: input.jobId ?? undefined,
    orgId: input.orgId ?? undefined,
    event: input.event,
    ...input.data,
  };
  logger[level](payload, input.message ?? input.event);

  try {
    await db.query(
      `INSERT INTO event_log (org_id, job_id, correlation_id, level, event, message, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.orgId ?? null,
        input.jobId ?? null,
        input.correlationId ?? null,
        level,
        input.event,
        input.message ?? '',
        JSON.stringify(input.data ?? {}),
      ],
    );
  } catch (err) {
    logger.warn({ err, event: input.event }, 'failed to persist event_log entry');
  }

  if (input.broadcast && input.jobId && input.orgId) {
    bus.publish({
      type: 'job.log',
      jobId: input.jobId,
      orgId: input.orgId,
      correlationId: input.correlationId ?? undefined,
      level,
      message: input.message ?? input.event,
      event: input.event,
    });
  }
}
