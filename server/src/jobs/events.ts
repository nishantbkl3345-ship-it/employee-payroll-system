import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';
import { logger } from '../logger.js';
import { jobEvents } from './progress.js';

/** Short id that ties an upload, its worker phases and its aggregation together. */
export const newCorrelationId = (): string => `job_${randomBytes(5).toString('hex')}`;

export interface JobLogEntry {
  orgId?: string | null;
  jobId?: string | null;
  correlationId?: string | null;
  level?: 'info' | 'warn' | 'error';
  event: string;
  message: string;
  data?: Record<string, unknown>;
  /** Also push to WebSocket clients watching this job. */
  broadcast?: boolean;
}

/**
 * Writes one event to stdout (for log shipping) and to `event_log` (so the job
 * page can show a trace without a log stack).
 *
 * Never throws: observability must not be able to fail a payroll run.
 */
export async function recordJobEvent(db: Db, entry: JobLogEntry): Promise<void> {
  const level = entry.level ?? 'info';
  logger[level](
    {
      correlationId: entry.correlationId ?? undefined,
      jobId: entry.jobId ?? undefined,
      orgId: entry.orgId ?? undefined,
      event: entry.event,
      ...entry.data,
    },
    entry.message,
  );

  try {
    await db.query(
      `INSERT INTO event_log (org_id, job_id, correlation_id, level, event, message, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.orgId ?? null,
        entry.jobId ?? null,
        entry.correlationId ?? null,
        level,
        entry.event,
        entry.message,
        JSON.stringify(entry.data ?? {}),
      ],
    );
  } catch (error) {
    logger.warn({ err: error, event: entry.event }, 'could not persist event_log entry');
  }

  if (entry.broadcast && entry.jobId && entry.orgId) {
    jobEvents.publish({
      type: 'job.log',
      jobId: entry.jobId,
      orgId: entry.orgId,
      correlationId: entry.correlationId ?? undefined,
      level,
      event: entry.event,
      message: entry.message,
    });
  }
}
