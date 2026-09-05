import type { App } from '../http.js';
import { requireAuth, scopeEmployeeCode } from '../auth/index.js';
import { config } from '../config.js';
import type { Db } from '../db/index.js';

const int = (v: unknown, d: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : d;
};

export function registerReportRoutes(app: App, db: Db): void {
  /**
   * Dashboard payload: the latest completed pay run plus organisation-wide
   * roll-ups that span every completed job.
   */
  app.get('/api/reports/overview', { preHandler: requireAuth }, async (req, reply) => {
    const orgId = req.auth!.orgId;

    const { rows: latestRows } = await db.query<any>(
      `SELECT j.id, j.filename, j.status, j.period_start, j.period_end, j.total_rows,
              j.valid_rows, j.invalid_rows, j.duplicate_rows, j.duration_ms, j.created_at,
              r.metrics
       FROM jobs j
       LEFT JOIN payroll_reports r ON r.job_id = j.id
       WHERE j.org_id = $1 AND j.status = 'completed'
       ORDER BY COALESCE(j.period_end, j.created_at::date) DESC, j.created_at DESC
       LIMIT 1`,
      [orgId],
    );

    const [jobStats, weeklyRows, activeRows] = await Promise.all([
      db.query<any>(
        `SELECT COUNT(*)::int AS total_jobs,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
                COUNT(*) FILTER (WHERE status = 'failed')::int    AS failed_jobs,
                COALESCE(SUM(total_rows), 0)::int                 AS rows_ingested
         FROM jobs WHERE org_id = $1`,
        [orgId],
      ),
      db.query<any>(
        `SELECT w.iso_week, MIN(w.week_start) AS week_start,
                ROUND(SUM(w.regular_hours)::numeric, 2)  AS regular_hours,
                ROUND(SUM(w.overtime_hours)::numeric, 2) AS overtime_hours,
                ROUND(SUM(w.gross_pay)::numeric, 2)      AS gross_pay,
                ROUND(SUM(w.overtime_pay)::numeric, 2)   AS overtime_pay
         FROM payroll_weekly w
         JOIN jobs j ON j.id = w.job_id AND j.status = 'completed'
         WHERE w.org_id = $1 AND w.department = '*'
         GROUP BY w.iso_week
         ORDER BY 2 DESC
         LIMIT 12`,
        [orgId],
      ),
      db.query<any>(
        `SELECT id, filename, status, stage, processed_rows, total_rows, created_at
         FROM jobs WHERE org_id = $1 AND status IN ('pending','queued','processing')
         ORDER BY created_at DESC LIMIT 5`,
        [orgId],
      ),
    ]);

    return reply.send({
      latestJob: latestRows[0]
        ? {
            id: latestRows[0].id,
            filename: latestRows[0].filename,
            periodStart: latestRows[0].period_start,
            periodEnd: latestRows[0].period_end,
            totalRows: latestRows[0].total_rows,
            validRows: latestRows[0].valid_rows,
            invalidRows: latestRows[0].invalid_rows,
            duplicateRows: latestRows[0].duplicate_rows,
            durationMs: latestRows[0].duration_ms,
            createdAt: latestRows[0].created_at,
          }
        : null,
      metrics: latestRows[0]?.metrics ?? null,
      organizationTrend: weeklyRows.rows.slice().reverse(),
      jobStats: jobStats.rows[0],
      activeJobs: activeRows.rows,
    });
  });

  /**
   * "Give me this department's payroll for the last N pay periods."
   * Served from the payroll_lines rollup, so it never touches raw rows.
   */
  app.get('/api/reports/department-history', { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    const periods = int(q.periods, 3, 1, 24);
    const params: any[] = [req.auth!.orgId, periods];
    let deptFilter = '';
    if (q.department && q.department !== 'all') {
      params.push(q.department);
      deptFilter = `AND pl.department = $${params.length}`;
    }

    const { rows } = await db.query(
      `WITH recent AS (
         SELECT id, filename, period_start, period_end, created_at
         FROM jobs
         WHERE org_id = $1 AND status = 'completed'
         ORDER BY COALESCE(period_end, created_at::date) DESC, created_at DESC
         LIMIT $2
       )
       SELECT r.id AS job_id, r.filename, r.period_start, r.period_end,
              pl.department,
              COUNT(*)::int                            AS employees,
              ROUND(SUM(pl.regular_hours)::numeric, 2)  AS regular_hours,
              ROUND(SUM(pl.overtime_hours)::numeric, 2) AS overtime_hours,
              ROUND(SUM(pl.overtime_pay)::numeric, 2)   AS overtime_pay,
              ROUND(SUM(pl.gross_pay)::numeric, 2)      AS gross_pay
       FROM recent r
       JOIN payroll_lines pl ON pl.job_id = r.id
       WHERE TRUE ${deptFilter}
       GROUP BY r.id, r.filename, r.period_start, r.period_end, pl.department
       ORDER BY r.period_end DESC NULLS LAST, pl.department ASC`,
      params,
    );
    return reply.send({ periods, department: q.department ?? 'all', rows });
  });

  /** Operational metrics: throughput, per-row cost and job failure rate. */
  app.get('/api/metrics/ops', { preHandler: requireAuth }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const [jobsQ, rowsQ, logsQ] = await Promise.all([
      db.query<any>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE status = 'failed')::int    AS failed,
                COALESCE(AVG(duration_ms) FILTER (WHERE status = 'completed'), 0) AS avg_duration_ms,
                COALESCE(MAX(duration_ms) FILTER (WHERE status = 'completed'), 0) AS max_duration_ms,
                COALESCE(AVG(avg_row_ms) FILTER (WHERE status = 'completed'), 0)  AS avg_row_ms,
                COALESCE(SUM(total_rows), 0)::int AS rows_ingested
         FROM jobs WHERE org_id = $1`,
        [orgId],
      ),
      db.query<any>(
        `SELECT COALESCE(AVG(processing_ms), 0) AS avg_row_processing_ms,
                COALESCE(SUM(attempts - 1), 0)::int AS retries
         FROM timesheet_rows WHERE org_id = $1`,
        [orgId],
      ),
      db.query<any>(
        `SELECT level, COUNT(*)::int AS count FROM event_log WHERE org_id = $1 GROUP BY level`,
        [orgId],
      ),
    ]);

    const j = jobsQ.rows[0];
    const total = Number(j.total) || 0;
    return reply.send({
      jobs: {
        total,
        completed: Number(j.completed),
        failed: Number(j.failed),
        failureRatePct: total > 0 ? Math.round((Number(j.failed) / total) * 10000) / 100 : 0,
        avgDurationMs: Math.round(Number(j.avg_duration_ms)),
        maxDurationMs: Math.round(Number(j.max_duration_ms)),
        rowsIngested: Number(j.rows_ingested),
      },
      rows: {
        avgWallClockMsPerRow: Number(Number(j.avg_row_ms).toFixed(3)),
        avgCpuMsPerRow: Number(Number(rowsQ.rows[0].avg_row_processing_ms).toFixed(3)),
        retries: Number(rowsQ.rows[0].retries),
      },
      logLevels: Object.fromEntries(logsQ.rows.map((r: any) => [r.level, r.count])),
      engine: {
        queueDriver: config.redisUrl ? 'bullmq' : 'memory',
        dbDriver: config.databaseUrl ? 'postgres' : 'pglite',
        workerConcurrency: config.workerConcurrency,
        rowDelayMs: config.rowProcessingDelayMs,
        rowMaxAttempts: config.rowMaxAttempts,
      },
    });
  });

  /** Recent system events across the organisation (observability panel). */
  app.get('/api/logs', { preHandler: requireAuth }, async (req, reply) => {
    if (scopeEmployeeCode(req.auth!)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Logs are restricted to admin and HR' });
    }
    const q = req.query as Record<string, string>;
    const limit = int(q.limit, 100, 1, 500);
    const params: any[] = [req.auth!.orgId];
    let where = 'org_id = $1';
    if (q.level && ['debug', 'info', 'warn', 'error'].includes(q.level)) {
      params.push(q.level);
      where += ` AND level = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT id, level, event, message, data, job_id, correlation_id, created_at
       FROM event_log WHERE ${where} ORDER BY id DESC LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    return reply.send({ logs: rows });
  });
}
