import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { logger } from '../logger.js';
import { rebuildPayrollReport, type PayrollMetrics } from '../payroll/aggregate.js';
import {
  applyWeeklyOvertime,
  groupBy,
  payWeekKey,
  resolveWorkday,
  workdayKey,
} from '../payroll/calculate.js';
import { parseTimesheet } from '../payroll/parse.js';
import type { OvertimeRules, TimesheetRow, UploadedRow } from '../payroll/types.js';
import { validateTimesheetRow } from '../payroll/validate.js';
import { recordJobEvent } from './events.js';
import { createProgressReporter, jobEvents } from './progress.js';
import { replaceTimesheetRows, syncEmployeeDirectory } from './timesheetStore.js';
import { runWorkerPool, sleep } from './workerPool.js';

interface PayrollJob {
  id: string;
  org_id: string;
  correlation_id: string;
  filename: string;
  status: string;
  rules: Partial<OvertimeRules>;
}

export interface RunPayrollJobOptions {
  db: Db;
  jobId: string;
  /** Aborted on shutdown so the worker pool stops pulling new rows. */
  signal?: AbortSignal;
  /** Overrides the simulated per-row cost; tests run with 0. */
  rowDelayMs?: number;
  concurrency?: number;
}

export interface PayrollJobResult {
  jobId: string;
  totalRows: number;
  durationMs: number;
  metrics: PayrollMetrics;
}

/**
 * Runs one uploaded timesheet through the payroll pipeline:
 * parse -> validate -> resolve workdays -> apply weekly overtime -> store -> aggregate.
 *
 * The three middle stages run on a worker pool. Validation fans out per row;
 * the cross-row rules fan out per employee-day and per employee-week, because
 * those groups are independent of each other but their rows are not.
 */
export async function runPayrollJob(options: RunPayrollJobOptions): Promise<PayrollJobResult> {
  const { db, jobId, signal } = options;
  const startedAt = performance.now();

  const job = await loadJob(db, jobId);
  const rules = await resolveRules(db, job);
  const concurrency = options.concurrency ?? config.workerConcurrency;
  const rowDelayMs = options.rowDelayMs ?? config.rowProcessingDelayMs;
  const report = createProgressReporter(db, job);

  await db.query(
    `UPDATE jobs
     SET status = 'processing', stage = 'parsing', started_at = now(),
         processed_rows = 0, error = NULL, attempts = attempts + 1
     WHERE id = $1`,
    [jobId],
  );
  jobEvents.publish({
    type: 'job.status',
    jobId,
    orgId: job.org_id,
    status: 'processing',
    stage: 'parsing',
    percent: 0,
  });
  await recordJobEvent(db, {
    orgId: job.org_id,
    jobId,
    correlationId: job.correlation_id,
    event: 'payroll_job.started',
    message: `Processing started for ${job.filename}`,
    data: { concurrency, rules },
    broadcast: true,
  });

  try {
    const uploaded = await parseUploadedFile(db, job);
    report.flush('parsing');

    const { rows, validation } = await validateRows(uploaded, {
      concurrency,
      rowDelayMs,
      signal,
      onProgress: (settled, total) => report('validating', settled, total),
    });
    report.flush('validating');

    await runWorkerPool([...groupBy(rows, workdayKey).values()], async (workday) => resolveWorkday(workday, rules), {
      concurrency,
      signal,
      onSettled: (settled, total) => report('resolving', settled, total),
    });
    report.flush('resolving');

    await runWorkerPool([...groupBy(rows, payWeekKey).values()], async (week) => applyWeeklyOvertime(week, rules), {
      concurrency,
      signal,
      onSettled: (settled, total) => report('overtime', settled, total),
    });
    report.flush('overtime');

    await replaceTimesheetRows(db, jobId, job.org_id, rows, (written, total) =>
      report('persisting', written, total),
    );
    await syncEmployeeDirectory(db, job.org_id, rows);
    report.flush('persisting');

    const { metrics, computedMs } = await rebuildPayrollReport(db, jobId, job.org_id, rules);
    const durationMs = performance.now() - startedAt;

    await db.query(
      `UPDATE jobs
       SET status = 'completed', stage = 'completed', finished_at = now(),
           duration_ms = $2, avg_row_ms = $3, retried_rows = $4,
           processed_rows = total_rows, error = NULL
       WHERE id = $1`,
      [jobId, Math.round(durationMs), validation.avgRowMs, validation.retriedRows],
    );

    await recordJobEvent(db, {
      orgId: job.org_id,
      jobId,
      correlationId: job.correlation_id,
      event: 'payroll_job.completed',
      message:
        `Completed in ${Math.round(durationMs)}ms — ${metrics.quality.validRows} valid, ` +
        `${metrics.quality.invalidRows} invalid, ${metrics.quality.duplicateRows} duplicate`,
      data: {
        durationMs: Math.round(durationMs),
        validationMs: Math.round(validation.durationMs),
        aggregationMs: Math.round(computedMs),
        rowCount: rows.length,
        retriedRows: validation.retriedRows,
        grossPay: metrics.totals.grossPay,
        concurrency,
      },
      broadcast: true,
    });

    jobEvents.publish({
      type: 'job.status',
      jobId,
      orgId: job.org_id,
      correlationId: job.correlation_id,
      status: 'completed',
      stage: 'completed',
      percent: 100,
      processedRows: rows.length,
      totalRows: rows.length,
    });

    return { jobId, totalRows: rows.length, durationMs, metrics };
  } catch (error) {
    await failJob(db, job, error, performance.now() - startedAt);
    throw error;
  }
}

async function loadJob(db: Db, jobId: string): Promise<PayrollJob> {
  const { rows } = await db.query<PayrollJob>(
    'SELECT id, org_id, correlation_id, filename, status, rules FROM jobs WHERE id = $1',
    [jobId],
  );
  if (!rows[0]) throw new Error(`payroll job ${jobId} not found`);
  return rows[0];
}

/** Per-upload rules win over the organisation's defaults. */
async function resolveRules(db: Db, job: PayrollJob): Promise<OvertimeRules> {
  const { rows } = await db.query<{
    ot_daily_threshold: number;
    ot_weekly_threshold: number;
    ot_multiplier: number;
  }>(
    'SELECT ot_daily_threshold, ot_weekly_threshold, ot_multiplier FROM organizations WHERE id = $1',
    [job.org_id],
  );
  const organization = rows[0];
  return {
    dailyThreshold: Number(job.rules?.dailyThreshold ?? organization?.ot_daily_threshold ?? config.overtime.dailyThreshold),
    weeklyThreshold: Number(job.rules?.weeklyThreshold ?? organization?.ot_weekly_threshold ?? config.overtime.weeklyThreshold),
    multiplier: Number(job.rules?.multiplier ?? organization?.ot_multiplier ?? config.overtime.multiplier),
  };
}

async function parseUploadedFile(db: Db, job: PayrollJob): Promise<UploadedRow[]> {
  const { rows } = await db.query<{ content: string }>(
    'SELECT content FROM job_files WHERE job_id = $1',
    [job.id],
  );
  if (!rows[0]) throw new Error('the uploaded file content is missing');

  const timesheet = parseTimesheet(rows[0].content, job.filename);
  await db.query('UPDATE jobs SET total_rows = $2, source_format = $3 WHERE id = $1', [
    job.id,
    timesheet.rows.length,
    timesheet.format,
  ]);
  await recordJobEvent(db, {
    orgId: job.org_id,
    jobId: job.id,
    correlationId: job.correlation_id,
    event: 'payroll_job.parsed',
    message: `Parsed ${timesheet.rows.length} rows from ${job.filename}`,
    data: { rowCount: timesheet.rows.length, format: timesheet.format, missingColumns: timesheet.missingColumns },
    broadcast: true,
  });
  return timesheet.rows;
}

interface ValidationRun {
  durationMs: number;
  avgRowMs: number;
  retriedRows: number;
}

async function validateRows(
  uploaded: UploadedRow[],
  options: {
    concurrency: number;
    rowDelayMs: number;
    signal?: AbortSignal;
    onProgress: (settled: number, total: number) => void;
  },
): Promise<{ rows: TimesheetRow[]; validation: ValidationRun }> {
  const pool = await runWorkerPool(
    uploaded,
    async (row) => {
      // Stands in for the per-row cost of a real system (rule lookups, policy
      // checks). Set ROW_PROCESSING_DELAY_MS=0 to remove it.
      if (options.rowDelayMs > 0) await sleep(options.rowDelayMs);
      return validateTimesheetRow(row);
    },
    {
      concurrency: options.concurrency,
      maxAttempts: config.rowMaxAttempts,
      signal: options.signal,
      onSettled: options.onProgress,
    },
  );

  const rows = pool.results.map((row, index) =>
    row ?? unprocessableRow(uploaded[index], index, pool.failures.find((f) => f.index === index)),
  );

  return {
    rows,
    validation: {
      durationMs: pool.durationMs,
      avgRowMs: uploaded.length > 0 ? pool.durationMs / uploaded.length : 0,
      retriedRows: pool.attempts - uploaded.length,
    },
  };
}

/** A row the pool could not process is surfaced as invalid, never dropped. */
function unprocessableRow(
  uploaded: UploadedRow | undefined,
  index: number,
  failure?: { attempts: number; error: Error },
): TimesheetRow {
  return {
    rowNumber: uploaded?.rowNumber ?? index + 1,
    employeeCode: String(uploaded?.employee_id ?? ''),
    employeeName: String(uploaded?.employee_name ?? ''),
    department: String(uploaded?.department ?? 'Unassigned'),
    workDate: null,
    clockIn: null,
    clockOut: null,
    clockInMinutes: null,
    clockOutMinutes: null,
    hourlyRate: null,
    status: 'invalid',
    errors: [
      {
        code: 'PROCESSING_ERROR',
        message: failure?.error.message ?? 'row processing failed after retries',
      },
    ],
    hoursWorked: 0,
    regularHours: 0,
    overtimeHours: 0,
    regularPay: 0,
    overtimePay: 0,
    grossPay: 0,
    isoWeek: null,
    weekStart: null,
    attempts: failure?.attempts ?? config.rowMaxAttempts,
    raw: { ...(uploaded ?? {}) },
  };
}

async function failJob(db: Db, job: PayrollJob, error: unknown, durationMs: number): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  await db
    .query(
      `UPDATE jobs SET status = 'failed', stage = 'failed', finished_at = now(),
                       duration_ms = $2, error = $3 WHERE id = $1`,
      [job.id, Math.round(durationMs), message],
    )
    .catch((dbError) => logger.error({ err: dbError, jobId: job.id }, 'could not mark job as failed'));

  await recordJobEvent(db, {
    orgId: job.org_id,
    jobId: job.id,
    correlationId: job.correlation_id,
    level: 'error',
    event: 'payroll_job.failed',
    message,
    data: { durationMs: Math.round(durationMs) },
    broadcast: true,
  });

  jobEvents.publish({
    type: 'job.status',
    jobId: job.id,
    orgId: job.org_id,
    status: 'failed',
    stage: 'failed',
    message,
  });
}

/** Rebuilds aggregates from stored rows, after a rate correction or a rules change. */
export async function rerunAggregation(db: Db, jobId: string): Promise<PayrollMetrics> {
  const job = await loadJob(db, jobId);
  const rules = await resolveRules(db, job);
  const { metrics, computedMs } = await rebuildPayrollReport(db, jobId, job.org_id, rules);

  await recordJobEvent(db, {
    orgId: job.org_id,
    jobId,
    correlationId: job.correlation_id,
    event: 'payroll_job.reaggregated',
    message: `Aggregates rebuilt in ${Math.round(computedMs)}ms`,
    data: { computedMs: Math.round(computedMs), rules },
    broadcast: true,
  });
  return metrics;
}
