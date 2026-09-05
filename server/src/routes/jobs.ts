import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole, restrictToOwnEmployeeCode } from '../auth/index.js';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { newCorrelationId, recordJobEvent } from '../jobs/events.js';
import { rerunAggregation } from '../jobs/processor.js';
import { getPayrollQueue } from '../jobs/queue.js';
import { parseTimesheet, TimesheetParseError } from '../payroll/parse.js';
import { pageFrom, requireJob } from './params.js';
import { registerExportRoutes } from './exports.js';

const ACCEPTED_EXTENSIONS = ['.csv', '.json', '.txt'];

/**
 * An overtime rule left blank in the upload form means "use the organisation's
 * setting", so it has to arrive as undefined. Coercing "" would make it 0,
 * which is a valid threshold meaning "every hour is overtime" — silently wrong
 * pay rather than an error.
 */
const overtimeRule = (min: number, max: number, label: string) =>
  z.preprocess(
    (value) => (value === '' || value === undefined ? undefined : value),
    z.coerce
      .number({ invalid_type_error: `${label} must be a number` })
      .min(min, `${label} must be at least ${min}`)
      .max(max, `${label} must be at most ${max}`)
      .optional(),
  );

const uploadRulesSchema = z.object({
  dailyThreshold: overtimeRule(0, 24, 'Daily threshold'),
  weeklyThreshold: overtimeRule(0, 168, 'Weekly threshold'),
  multiplier: overtimeRule(1, 5, 'Overtime multiplier'),
});

/** Payroll table sort keys, mapped to real columns so the input never reaches SQL. */
const PAYROLL_SORT_COLUMNS: Record<string, string> = {
  employee: 'employee_name',
  code: 'employee_code',
  department: 'department',
  days: 'days_worked',
  regular: 'regular_hours',
  overtime: 'overtime_hours',
  total: 'total_hours',
  rate: 'hourly_rate',
  gross: 'gross_pay',
};

export function registerJobRoutes(app: FastifyInstance, db: Db): void {
  const queue = getPayrollQueue(db);

  app.post(
    '/api/jobs/upload',
    {
      preHandler: requireRole('admin', 'hr'),
      config: {
        rateLimit: {
          max: config.uploadRateLimitPerMin,
          timeWindow: '1 minute',
          // Rate limiting runs before authentication, so the token is hashed
          // rather than kept verbatim as a map key.
          keyGenerator: (req: FastifyRequest) => {
            const header = req.headers.authorization;
            return header ? createHash('sha256').update(header).digest('hex') : req.ip;
          },
        },
      },
    },
    async (req, reply) => {
      const upload = await req.file();
      if (!upload) {
        return reply
          .code(400)
          .send({ error: 'no_file', message: 'Attach a CSV or JSON file in the "file" field' });
      }

      const extension = (upload.filename ?? '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
      if (extension && !ACCEPTED_EXTENSIONS.includes(extension)) {
        return reply.code(415).send({
          error: 'unsupported_file_type',
          message: `Expected a CSV or JSON file, got "${upload.filename}"`,
        });
      }

      let content: Buffer;
      try {
        content = await upload.toBuffer();
      } catch (error) {
        if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply
            .code(413)
            .send({ error: 'file_too_large', message: `File exceeds the ${config.maxUploadMb}MB limit` });
        }
        throw error;
      }

      const parsedRules = uploadRulesSchema.safeParse(req.query);
      if (!parsedRules.success) {
        return reply.code(400).send({
          error: 'invalid_overtime_rules',
          message: parsedRules.error.issues.map((issue) => issue.message).join('; '),
        });
      }
      const rules = parsedRules.data;

      // Parse before creating the job so an unreadable file fails fast with a
      // useful message instead of leaving a failed job behind.
      let timesheet;
      try {
        timesheet = parseTimesheet(content, upload.filename ?? 'upload.csv');
      } catch (error) {
        if (!(error instanceof TimesheetParseError)) throw error;
        await recordJobEvent(db, {
          orgId: req.auth!.orgId,
          level: 'warn',
          event: 'upload.rejected',
          message: error.message,
          data: { filename: upload.filename, bytes: content.length },
        });
        return reply.code(400).send({ error: 'unreadable_file', message: error.message, detail: error.detail });
      }

      const correlationId = newCorrelationId();
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO jobs (org_id, uploaded_by, correlation_id, filename, source_format,
                           byte_size, status, stage, total_rows, rules)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'uploaded', $7, $8::jsonb)
         RETURNING id`,
        [
          req.auth!.orgId,
          req.auth!.id,
          correlationId,
          upload.filename ?? 'upload.csv',
          timesheet.format,
          content.length,
          timesheet.rows.length,
          JSON.stringify(rules),
        ],
      );
      const jobId = rows[0].id;
      await db.query('INSERT INTO job_files (job_id, content) VALUES ($1, $2)', [
        jobId,
        content.toString('utf8'),
      ]);

      await recordJobEvent(db, {
        orgId: req.auth!.orgId,
        jobId,
        correlationId,
        event: 'upload.received',
        message: `${req.auth!.email} uploaded ${upload.filename}`,
        data: {
          filename: upload.filename,
          bytes: content.length,
          rowCount: timesheet.rows.length,
          format: timesheet.format,
          missingColumns: timesheet.missingColumns,
        },
      });

      const autoProcess = (req.query as { autoProcess?: string }).autoProcess !== 'false';
      if (autoProcess) await queue.enqueue(jobId, req.auth!.orgId);

      return reply.code(201).send({
        job: {
          id: jobId,
          correlationId,
          filename: upload.filename,
          totalRows: timesheet.rows.length,
          status: autoProcess ? 'queued' : 'pending',
          format: timesheet.format,
          missingColumns: timesheet.missingColumns,
          rules,
        },
      });
    },
  );

  app.post('/api/jobs/:id/process', { preHandler: requireRole('admin', 'hr') }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;

    if (job.status === 'processing' || job.status === 'queued') {
      return reply.code(409).send({ error: 'already_running', message: 'This job is already in the queue' });
    }

    await queue.enqueue(job.id, job.org_id);
    await recordJobEvent(db, {
      orgId: job.org_id,
      jobId: job.id,
      correlationId: job.correlation_id,
      event: 'payroll_job.enqueued',
      message: `Processing triggered by ${req.auth!.email}`,
      broadcast: true,
    });
    return reply.send({ ok: true, jobId: job.id, status: 'queued' });
  });

  app.post('/api/jobs/:id/reaggregate', { preHandler: requireRole('admin', 'hr') }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;
    if (job.status !== 'completed') {
      return reply
        .code(409)
        .send({ error: 'not_completed', message: 'Aggregation can only be re-run on a completed job' });
    }
    return reply.send({ ok: true, metrics: await rerunAggregation(db, job.id) });
  });

  /**
   * Corrects one employee's rate for a pay run. Hours do not depend on the
   * rate, so the rows are re-priced in place and the aggregates rebuilt;
   * anything that could change hours goes through /process instead.
   */
  app.patch(
    '/api/jobs/:id/employees/:code/rate',
    { preHandler: requireRole('admin', 'hr') },
    async (req, reply) => {
      const job = await requireJob(db, req, reply);
      if (!job) return;

      const body = z.object({ hourlyRate: z.number().positive().max(100_000) }).safeParse(req.body);
      if (!body.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', message: 'hourlyRate must be a positive number' });
      }

      const { code } = req.params as { code: string };
      const multiplier = await overtimeMultiplierFor(db, job.id, job.org_id);
      const { hourlyRate } = body.data;

      const { rowCount } = await db.query(
        `UPDATE timesheet_rows
         SET hourly_rate  = $3::numeric,
             regular_pay  = ROUND(regular_hours * $3::numeric, 2),
             overtime_pay = ROUND(overtime_hours * $3::numeric * $4::numeric, 2),
             gross_pay    = ROUND(regular_hours * $3::numeric, 2)
                          + ROUND(overtime_hours * $3::numeric * $4::numeric, 2)
         WHERE job_id = $1 AND employee_code = $2 AND status = 'valid'`,
        [job.id, code, hourlyRate, multiplier],
      );
      if (!rowCount) {
        return reply.code(404).send({ error: 'not_found', message: 'No valid rows for that employee' });
      }

      await recordJobEvent(db, {
        orgId: job.org_id,
        jobId: job.id,
        correlationId: job.correlation_id,
        level: 'warn',
        event: 'payroll.rate_corrected',
        message: `${req.auth!.email} set ${code} to ${hourlyRate}/h across ${rowCount} row(s)`,
        data: { employeeCode: code, hourlyRate, rowCount },
        broadcast: true,
      });

      return reply.send({ ok: true, updatedRows: rowCount, metrics: await rerunAggregation(db, job.id) });
    },
  );

  app.get('/api/jobs', { preHandler: requireAuth }, async (req, reply) => {
    const { limit, offset } = pageFrom(req.query as Record<string, string>, 25);
    const { rows } = await db.query(
      `SELECT j.id, j.filename, j.status, j.stage, j.total_rows, j.processed_rows, j.valid_rows,
              j.invalid_rows, j.duplicate_rows, j.period_start, j.period_end, j.correlation_id,
              j.duration_ms, j.avg_row_ms, j.created_at, j.finished_at, j.error, j.rules,
              u.name AS uploaded_by_name,
              COALESCE((r.metrics->'totals'->>'grossPay')::numeric, 0) AS gross_pay
       FROM jobs j
       LEFT JOIN users u ON u.id = j.uploaded_by
       LEFT JOIN payroll_reports r ON r.job_id = j.id
       WHERE j.org_id = $1
       ORDER BY j.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.auth!.orgId, limit, offset],
    );
    const { rows: totals } = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM jobs WHERE org_id = $1',
      [req.auth!.orgId],
    );
    return reply.send({ jobs: rows, total: totals[0].count, limit, offset });
  });

  app.get('/api/jobs/:id', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;

    const { rows } = await db.query(
      `SELECT j.*, u.name AS uploaded_by_name, u.email AS uploaded_by_email
       FROM jobs j LEFT JOIN users u ON u.id = j.uploaded_by WHERE j.id = $1`,
      [job.id],
    );
    const { rows: reports } = await db.query(
      'SELECT metrics, generated_at FROM payroll_reports WHERE job_id = $1',
      [job.id],
    );
    return reply.send({
      job: rows[0],
      metrics: reports[0]?.metrics ?? null,
      generatedAt: reports[0]?.generated_at ?? null,
    });
  });

  app.get('/api/jobs/:id/metrics', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;
    const { rows } = await db.query('SELECT metrics FROM payroll_reports WHERE job_id = $1', [job.id]);
    if (!rows[0]) {
      return reply.code(404).send({ error: 'not_found', message: 'This job has not been aggregated yet' });
    }
    return reply.send({ metrics: rows[0].metrics });
  });

  /** Every ingested row with its verdict — the error report view. */
  app.get('/api/jobs/:id/rows', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;

    const query = req.query as Record<string, string>;
    const { limit, offset } = pageFrom(query);
    const filters = ['job_id = $1'];
    const params: unknown[] = [job.id];

    if (['valid', 'invalid', 'duplicate'].includes(query.status)) {
      params.push(query.status);
      filters.push(`status = $${params.length}`);
    }
    if (query.q) {
      params.push(`%${query.q.toLowerCase()}%`);
      filters.push(
        `(LOWER(COALESCE(employee_code, '')) LIKE $${params.length}
          OR LOWER(COALESCE(employee_name, '')) LIKE $${params.length}
          OR LOWER(COALESCE(department, '')) LIKE $${params.length})`,
      );
    }
    const ownCode = restrictToOwnEmployeeCode(req.auth!);
    if (ownCode) {
      params.push(ownCode);
      filters.push(`employee_code = $${params.length}`);
    }
    const where = filters.join(' AND ');

    const { rows } = await db.query(
      `SELECT row_number, employee_code, employee_name, department, work_date, clock_in, clock_out,
              hourly_rate, status, errors, hours_worked, regular_hours, overtime_hours,
              regular_pay, overtime_pay, gross_pay, iso_week, attempts
       FROM timesheet_rows WHERE ${where}
       ORDER BY row_number ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const { rows: totals } = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM timesheet_rows WHERE ${where}`,
      params,
    );
    return reply.send({ rows, total: totals[0].count, limit, offset });
  });

  /** One payroll line per employee, sortable and searchable. */
  app.get('/api/jobs/:id/payroll', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;

    const query = req.query as Record<string, string>;
    const { limit, offset } = pageFrom(query);
    const sortKey = query.sort ?? 'gross';
    const sortColumn = PAYROLL_SORT_COLUMNS[sortKey] ?? PAYROLL_SORT_COLUMNS.gross;
    const direction = query.dir === 'asc' ? 'ASC' : 'DESC';

    const filters = ['job_id = $1'];
    const params: unknown[] = [job.id];

    if (query.q) {
      params.push(`%${query.q.toLowerCase()}%`);
      filters.push(
        `(LOWER(employee_code) LIKE $${params.length} OR LOWER(employee_name) LIKE $${params.length})`,
      );
    }
    if (query.department && query.department !== 'all') {
      params.push(query.department);
      filters.push(`department = $${params.length}`);
    }
    const ownCode = restrictToOwnEmployeeCode(req.auth!);
    if (ownCode) {
      params.push(ownCode);
      filters.push(`employee_code = $${params.length}`);
    }
    const where = filters.join(' AND ');

    const { rows } = await db.query(
      `SELECT employee_code, employee_name, department, days_worked, regular_hours, overtime_hours,
              total_hours, avg_daily_hours, hourly_rate, regular_pay, overtime_pay, gross_pay
       FROM payroll_lines WHERE ${where}
       ORDER BY ${sortColumn} ${direction}, employee_code ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const { rows: totals } = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM payroll_lines WHERE ${where}`,
      params,
    );
    return reply.send({
      rows,
      total: totals[0].count,
      limit,
      offset,
      sort: sortKey,
      dir: direction.toLowerCase(),
    });
  });

  app.get('/api/jobs/:id/logs', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;
    const { rows } = await db.query(
      `SELECT id, level, event, message, data, created_at
       FROM event_log WHERE job_id = $1 ORDER BY id ASC LIMIT 500`,
      [job.id],
    );
    return reply.send({ correlationId: job.correlation_id, logs: rows });
  });

  registerExportRoutes(app, db);
}

async function overtimeMultiplierFor(db: Db, jobId: string, orgId: string): Promise<number> {
  const { rows } = await db.query<{ multiplier: number }>(
    `SELECT COALESCE((j.rules->>'multiplier')::numeric, o.ot_multiplier) AS multiplier
     FROM jobs j JOIN organizations o ON o.id = j.org_id
     WHERE j.id = $1 AND j.org_id = $2`,
    [jobId, orgId],
  );
  return Number(rows[0]?.multiplier ?? config.overtime.multiplier);
}
