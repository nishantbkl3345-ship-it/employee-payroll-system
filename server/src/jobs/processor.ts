import { config, type OvertimeRules } from '../config.js';
import type { Db } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { recordEvent } from '../lib/eventlog.js';
import { runPool } from '../lib/pool.js';
import { sleep } from '../lib/sleep.js';
import { jobLogger } from '../logger.js';
import { aggregateJob, type PayrollMetrics } from '../payroll/aggregate.js';
import { applyWeeklyOvertime, groupBy, resolveDay } from '../payroll/compute.js';
import { parseUpload } from '../payroll/parse.js';
import type { ProcessedRow } from '../payroll/types.js';
import { dayKey, validateRow, weekKey } from '../payroll/validate.js';

export interface JobRecord {
  id: string;
  org_id: string;
  correlation_id: string;
  filename: string;
  status: string;
  rules: Partial<OvertimeRules> & { maxShiftHours?: number };
}

export interface ProcessOptions {
  db: Db;
  jobId: string;
  signal?: AbortSignal;
  /** Overrides the artificial per-row cost; used by tests to run instantly. */
  rowDelayMs?: number;
  concurrency?: number;
}

export interface ProcessResult {
  jobId: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  durationMs: number;
  avgRowMs: number;
  metrics: PayrollMetrics;
}

/** Progress is reported as a single 0-100 number so the UI has one source of truth. */
const STAGE_WEIGHTS: Array<[string, number]> = [
  ['parsing', 5],
  ['validating', 65],
  ['resolving', 10],
  ['overtime', 8],
  ['persisting', 7],
  ['aggregating', 5],
];
const stageFloor = (stage: string): number => {
  let acc = 0;
  for (const [name, weight] of STAGE_WEIGHTS) {
    if (name === stage) return acc;
    acc += weight;
  }
  return acc;
};
const stageWeight = (stage: string): number =>
  STAGE_WEIGHTS.find(([name]) => name === stage)?.[1] ?? 0;

export async function processJob(opts: ProcessOptions): Promise<ProcessResult> {
  const { db, jobId } = opts;
  const startedAt = performance.now();

  const { rows: jobRows } = await db.query<JobRecord>(
    `SELECT j.id, j.org_id, j.correlation_id, j.filename, j.status, j.rules
     FROM jobs j WHERE j.id = $1`,
    [jobId],
  );
  const job = jobRows[0];
  if (!job) throw new Error(`job ${jobId} not found`);

  const log = jobLogger(job.correlation_id, job.id);
  const orgId = job.org_id;

  const { rows: orgRows } = await db.query<{
    ot_daily_threshold: number;
    ot_weekly_threshold: number;
    ot_multiplier: number;
  }>('SELECT ot_daily_threshold, ot_weekly_threshold, ot_multiplier FROM organizations WHERE id = $1', [
    orgId,
  ]);
  const org = orgRows[0];
  const rules: OvertimeRules = {
    dailyThreshold: Number(job.rules?.dailyThreshold ?? org?.ot_daily_threshold ?? config.overtime.dailyThreshold),
    weeklyThreshold: Number(job.rules?.weeklyThreshold ?? org?.ot_weekly_threshold ?? config.overtime.weeklyThreshold),
    multiplier: Number(job.rules?.multiplier ?? org?.ot_multiplier ?? config.overtime.multiplier),
  };
  const maxShiftHours = job.rules?.maxShiftHours;

  const concurrency = opts.concurrency ?? config.workerConcurrency;
  const rowDelayMs = opts.rowDelayMs ?? config.rowProcessingDelayMs;

  // ---- progress plumbing (throttled: the DB must not be hammered per row) ----
  let lastPush = 0;
  let lastPersistedRows = 0;
  const push = (stage: string, done: number, total: number, force = false) => {
    const percent = Math.min(
      100,
      Math.round(stageFloor(stage) + (total > 0 ? (done / total) * stageWeight(stage) : stageWeight(stage))),
    );
    const now = Date.now();
    if (!force && now - lastPush < 200) return;
    lastPush = now;
    bus.publish({
      type: 'job.progress',
      jobId,
      orgId,
      correlationId: job.correlation_id,
      status: 'processing',
      stage,
      processedRows: stage === 'validating' ? done : lastPersistedRows,
      totalRows: total,
      percent,
    });
    if (stage === 'validating' && done !== lastPersistedRows) {
      lastPersistedRows = done;
      void db
        .query('UPDATE jobs SET processed_rows = $2, stage = $3 WHERE id = $1', [jobId, done, stage])
        .catch(() => {});
    } else {
      void db.query('UPDATE jobs SET stage = $2 WHERE id = $1', [jobId, stage]).catch(() => {});
    }
  };

  await db.query(
    `UPDATE jobs SET status = 'processing', stage = 'parsing', started_at = now(),
                     processed_rows = 0, error = NULL, attempts = attempts + 1
     WHERE id = $1`,
    [jobId],
  );
  bus.publish({ type: 'job.status', jobId, orgId, status: 'processing', stage: 'parsing', percent: 0 });
  await recordEvent(db, {
    orgId,
    jobId,
    correlationId: job.correlation_id,
    event: 'job.started',
    message: `Processing started for ${job.filename}`,
    data: { concurrency, rowDelayMs, rules },
    broadcast: true,
  });

  try {
    // ------------------------------------------------------------------
    // 0. Load + parse
    // ------------------------------------------------------------------
    const { rows: fileRows } = await db.query<{ content: string }>(
      'SELECT content FROM job_files WHERE job_id = $1',
      [jobId],
    );
    if (!fileRows[0]) throw new Error('uploaded file content is missing');

    const parsed = parseUpload(fileRows[0].content, job.filename);
    const total = parsed.rows.length;
    await db.query('UPDATE jobs SET total_rows = $2, source_format = $3 WHERE id = $1', [
      jobId,
      total,
      parsed.format,
    ]);
    push('parsing', 1, 1, true);
    await recordEvent(db, {
      orgId,
      jobId,
      correlationId: job.correlation_id,
      event: 'job.parsed',
      message: `Parsed ${total} rows from ${job.filename}`,
      data: { total, format: parsed.format, missingColumns: parsed.missingColumns },
      broadcast: true,
    });

    // ------------------------------------------------------------------
    // 1. Concurrent per-row validation (worker pool)
    //    Each row carries a simulated processing cost, so this phase is where
    //    concurrency actually buys wall-clock time.
    // ------------------------------------------------------------------
    const phaseA = await runPool(
      parsed.rows,
      async (raw) => {
        if (rowDelayMs > 0) await sleep(rowDelayMs);
        const t0 = performance.now();
        const row = validateRow(raw, { maxShiftHours });
        row.processingMs = performance.now() - t0;
        return row;
      },
      {
        concurrency,
        maxAttempts: config.rowMaxAttempts,
        retryBaseMs: 10,
        signal: opts.signal,
        onSettled: (done) => push('validating', done, total),
      },
    );
    push('validating', total, total, true);

    const processed: ProcessedRow[] = [];
    phaseA.results.forEach((row, i) => {
      if (row) {
        processed.push(row);
        return;
      }
      // A row that could not be processed at all is surfaced, never dropped.
      const failure = phaseA.failures.find((f) => f.index === i);
      const raw = parsed.rows[i];
      processed.push({
        rowNumber: raw?.rowNumber ?? i + 1,
        employeeCode: String(raw?.employee_id ?? ''),
        employeeName: String(raw?.employee_name ?? ''),
        department: String(raw?.department ?? 'Unassigned'),
        workDate: null,
        clockIn: null,
        clockOut: null,
        minutesIn: null,
        minutesOut: null,
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
        grossPay: 0,
        isoWeek: null,
        weekStart: null,
        attempts: failure?.attempts ?? config.rowMaxAttempts,
        processingMs: 0,
        raw: { ...(raw ?? {}) },
      });
    });

    if (phaseA.failures.length) {
      await recordEvent(db, {
        orgId,
        jobId,
        correlationId: job.correlation_id,
        level: 'warn',
        event: 'rows.processing_failed',
        message: `${phaseA.failures.length} row(s) failed after ${config.rowMaxAttempts} attempts`,
        data: { count: phaseA.failures.length },
        broadcast: true,
      });
    }

    // ------------------------------------------------------------------
    // 2. Concurrent per-(employee, day) resolution: duplicates, overlapping
    //    shifts and the daily regular/overtime split. Groups are independent,
    //    so this is safe to run in parallel and is order-independent.
    // ------------------------------------------------------------------
    const dayGroups = [...groupBy(processed, dayKey).values()];
    await runPool(dayGroups, async (group) => resolveDay(group, rules), {
      concurrency,
      signal: opts.signal,
      onSettled: (done, t) => push('resolving', done, t),
    });
    push('resolving', 1, 1, true);

    // ------------------------------------------------------------------
    // 3. Concurrent per-(employee, week) overtime reallocation + gross pay
    // ------------------------------------------------------------------
    const weekGroups = [...groupBy(processed, weekKey).values()];
    await runPool(weekGroups, async (group) => applyWeeklyOvertime(group, rules), {
      concurrency,
      signal: opts.signal,
      onSettled: (done, t) => push('overtime', done, t),
    });
    push('overtime', 1, 1, true);

    // ------------------------------------------------------------------
    // 4. Persist rows + employee directory
    // ------------------------------------------------------------------
    push('persisting', 0, 1, true);
    await db.query('DELETE FROM timesheet_rows WHERE job_id = $1', [jobId]);
    await insertRows(db, jobId, orgId, processed, (done, t) => push('persisting', done, t));
    await upsertEmployees(db, orgId, processed);
    push('persisting', 1, 1, true);

    // ------------------------------------------------------------------
    // 5. Aggregate
    // ------------------------------------------------------------------
    push('aggregating', 0, 1, true);
    const { metrics, computedMs } = await aggregateJob(db, jobId, orgId, rules);

    const durationMs = performance.now() - startedAt;
    const avgRowMs = total > 0 ? phaseA.durationMs / total : 0;

    await db.query(
      `UPDATE jobs SET status = 'completed', stage = 'completed', finished_at = now(),
                       duration_ms = $2, avg_row_ms = $3, processed_rows = total_rows, error = NULL
       WHERE id = $1`,
      [jobId, Math.round(durationMs), avgRowMs],
    );

    await recordEvent(db, {
      orgId,
      jobId,
      correlationId: job.correlation_id,
      event: 'job.completed',
      message: `Completed in ${Math.round(durationMs)}ms — ${metrics.quality.validRows} valid, ${metrics.quality.invalidRows} invalid, ${metrics.quality.duplicateRows} duplicate`,
      data: {
        durationMs: Math.round(durationMs),
        validateMs: Math.round(phaseA.durationMs),
        aggregateMs: Math.round(computedMs),
        avgRowMs: Number(avgRowMs.toFixed(3)),
        concurrency,
        rowRetries: phaseA.attempts - total,
        grossPay: metrics.totals.grossPay,
      },
      broadcast: true,
    });

    bus.publish({
      type: 'job.status',
      jobId,
      orgId,
      correlationId: job.correlation_id,
      status: 'completed',
      stage: 'completed',
      percent: 100,
      processedRows: total,
      totalRows: total,
    });

    log.info({ durationMs: Math.round(durationMs) }, 'job completed');

    return {
      jobId,
      totalRows: total,
      validRows: metrics.quality.validRows,
      invalidRows: metrics.quality.invalidRows,
      duplicateRows: metrics.quality.duplicateRows,
      durationMs,
      avgRowMs,
      metrics,
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    await db
      .query(
        `UPDATE jobs SET status = 'failed', stage = 'failed', finished_at = now(),
                         duration_ms = $2, error = $3 WHERE id = $1`,
        [jobId, Math.round(performance.now() - startedAt), error.message],
      )
      .catch(() => {});
    await recordEvent(db, {
      orgId,
      jobId,
      correlationId: job.correlation_id,
      level: 'error',
      event: 'job.failed',
      message: error.message,
      data: { stack: error.stack?.split('\n').slice(0, 4).join('\n') },
      broadcast: true,
    }).catch(() => {});
    bus.publish({
      type: 'job.status',
      jobId,
      orgId,
      status: 'failed',
      stage: 'failed',
      message: error.message,
    });
    throw error;
  }
}

const INSERT_BATCH = 250;

async function insertRows(
  db: Db,
  jobId: string,
  orgId: string,
  rows: ProcessedRow[],
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  if (!rows.length) return;
  const COLS = 21;
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH) {
    const batch = rows.slice(offset, offset + INSERT_BATCH);
    const values: any[] = [];
    const tuples = batch.map((row, i) => {
      const b = i * COLS;
      values.push(
        jobId,
        orgId,
        row.rowNumber,
        row.employeeCode || null,
        row.employeeName || null,
        row.department || null,
        row.workDate,
        row.clockIn,
        row.clockOut,
        row.hourlyRate,
        row.status,
        JSON.stringify(row.errors),
        row.hoursWorked,
        row.regularHours,
        row.overtimeHours,
        row.grossPay,
        row.isoWeek,
        row.weekStart,
        row.attempts,
        Number(row.processingMs.toFixed(3)),
        JSON.stringify(row.raw),
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12}::jsonb,$${b + 13},$${b + 14},$${b + 15},$${b + 16},$${b + 17},$${b + 18},$${b + 19},$${b + 20},$${b + 21}::jsonb)`;
    });

    await db.query(
      `INSERT INTO timesheet_rows
         (job_id, org_id, row_number, employee_code, employee_name, department, work_date,
          clock_in, clock_out, hourly_rate, status, errors, hours_worked, regular_hours,
          overtime_hours, gross_pay, iso_week, week_start, attempts, processing_ms, raw)
       VALUES ${tuples.join(',')}`,
      values,
    );
    onProgress(Math.min(offset + batch.length, rows.length), rows.length);
  }
}

async function upsertEmployees(db: Db, orgId: string, rows: ProcessedRow[]): Promise<void> {
  const directory = new Map<string, { name: string; department: string }>();
  for (const row of rows) {
    if (row.status !== 'valid' || !row.employeeCode) continue;
    directory.set(row.employeeCode, { name: row.employeeName, department: row.department });
  }
  for (const [code, info] of directory) {
    await db.query(
      `INSERT INTO employees (org_id, employee_code, name, department)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, employee_code)
       DO UPDATE SET name = EXCLUDED.name, department = EXCLUDED.department`,
      [orgId, code, info.name, info.department],
    );
  }
}

/** Re-runs aggregation only (used after a rate correction or a rules change). */
export async function reaggregateJob(db: Db, jobId: string): Promise<PayrollMetrics> {
  const { rows } = await db.query<JobRecord>(
    'SELECT id, org_id, correlation_id, filename, status, rules FROM jobs WHERE id = $1',
    [jobId],
  );
  const job = rows[0];
  if (!job) throw new Error(`job ${jobId} not found`);

  const { rows: orgRows } = await db.query<any>(
    'SELECT ot_daily_threshold, ot_weekly_threshold, ot_multiplier FROM organizations WHERE id = $1',
    [job.org_id],
  );
  const rules: OvertimeRules = {
    dailyThreshold: Number(job.rules?.dailyThreshold ?? orgRows[0]?.ot_daily_threshold ?? 8),
    weeklyThreshold: Number(job.rules?.weeklyThreshold ?? orgRows[0]?.ot_weekly_threshold ?? 40),
    multiplier: Number(job.rules?.multiplier ?? orgRows[0]?.ot_multiplier ?? 1.5),
  };
  const { metrics, computedMs } = await aggregateJob(db, jobId, job.org_id, rules);
  await recordEvent(db, {
    orgId: job.org_id,
    jobId,
    correlationId: job.correlation_id,
    event: 'job.reaggregated',
    message: `Aggregates rebuilt in ${Math.round(computedMs)}ms`,
    data: { computedMs: Math.round(computedMs), rules },
    broadcast: true,
  });
  return metrics;
}
