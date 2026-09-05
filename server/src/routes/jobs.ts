import type { FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../http.js';
import { z } from 'zod';
import { requireAuth, requireRole, scopeEmployeeCode } from '../auth/index.js';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { correlationId as newCorrelationId } from '../lib/ids.js';
import { recordEvent } from '../lib/eventlog.js';
import { getQueue } from '../jobs/queue.js';
import { reaggregateJob } from '../jobs/processor.js';
import { parseUpload, UploadParseError } from '../payroll/parse.js';
import { toCsv } from '../lib/csv.js';

const int = (v: unknown, d: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : d;
};

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

interface JobRow {
  id: string;
  org_id: string;
  correlation_id: string;
  status: string;
}

async function loadJob(db: Db, jobId: string, orgId: string): Promise<JobRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const { rows } = await db.query<JobRow>(
    'SELECT id, org_id, correlation_id, status FROM jobs WHERE id = $1 AND org_id = $2',
    [jobId, orgId],
  );
  return rows[0] ?? null;
}

async function requireJob(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<JobRow | null> {
  const jobId = (req.params as any).id as string;
  const job = await loadJob(db, jobId, req.auth!.orgId);
  if (!job) {
    await reply.code(404).send({ error: 'not_found', message: 'Job not found in your organisation' });
    return null;
  }
  return job;
}

export function registerJobRoutes(app: App, db: Db): void {
  const queue = getQueue(db);

  /* ------------------------------------------------------------------ *
   * Upload
   * ------------------------------------------------------------------ */
  app.post(
    '/api/jobs/upload',
    {
      preHandler: requireRole('admin', 'hr'),
      config: {
        rateLimit: {
          max: config.uploadRateLimitPerMin,
          timeWindow: '1 minute',
          // The rate-limit hook runs before auth, so key on the raw token.
          keyGenerator: (req: FastifyRequest) => (req.headers.authorization as string) ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const started = Date.now();
      const file = await (req as any).file();
      if (!file) {
        return reply
          .code(400)
          .send({ error: 'no_file', message: 'Attach a CSV or JSON file in the "file" field' });
      }

      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch (e) {
        return reply.code(413).send({
          error: 'file_too_large',
          message: `File exceeds the ${config.maxUploadMb}MB limit`,
        });
      }

      const q = req.query as Record<string, string>;
      const rules: Record<string, number> = {};
      const daily = num(q.dailyThreshold);
      const weekly = num(q.weeklyThreshold);
      const multiplier = num(q.multiplier);
      const maxShiftHours = num(q.maxShiftHours);
      if (daily !== undefined) rules.dailyThreshold = daily;
      if (weekly !== undefined) rules.weeklyThreshold = weekly;
      if (multiplier !== undefined) rules.multiplier = multiplier;
      if (maxShiftHours !== undefined) rules.maxShiftHours = maxShiftHours;

      // Fail fast on an unparseable file rather than creating a doomed job.
      let preview: ReturnType<typeof parseUpload>;
      try {
        preview = parseUpload(buffer, file.filename ?? 'upload.csv');
      } catch (e) {
        const err = e as UploadParseError;
        await recordEvent(db, {
          orgId: req.auth!.orgId,
          level: 'warn',
          event: 'upload.rejected',
          message: err.message,
          data: { filename: file.filename, bytes: buffer.length },
        });
        return reply.code(400).send({ error: 'unparseable_file', message: err.message, detail: err.detail });
      }

      const corrId = newCorrelationId();
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO jobs (org_id, uploaded_by, correlation_id, filename, source_format, byte_size, status, stage, total_rows, rules)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'uploaded', $7, $8::jsonb)
         RETURNING id`,
        [
          req.auth!.orgId,
          req.auth!.id,
          corrId,
          file.filename ?? 'upload.csv',
          preview.format,
          buffer.length,
          preview.rows.length,
          JSON.stringify(rules),
        ],
      );
      const jobId = rows[0].id;
      await db.query('INSERT INTO job_files (job_id, content) VALUES ($1, $2)', [
        jobId,
        buffer.toString('utf8'),
      ]);

      await recordEvent(db, {
        orgId: req.auth!.orgId,
        jobId,
        correlationId: corrId,
        event: 'upload.received',
        message: `${req.auth!.email} uploaded ${file.filename} (${preview.rows.length} rows, ${buffer.length} bytes)`,
        data: {
          filename: file.filename,
          bytes: buffer.length,
          rows: preview.rows.length,
          format: preview.format,
          missingColumns: preview.missingColumns,
          uploadMs: Date.now() - started,
        },
      });

      const autoProcess = q.autoProcess !== 'false';
      if (autoProcess) await queue.enqueue(jobId, req.auth!.orgId);

      return reply.code(201).send({
        job: {
          id: jobId,
          correlationId: corrId,
          filename: file.filename,
          totalRows: preview.rows.length,
          status: autoProcess ? 'queued' : 'pending',
          format: preview.format,
          missingColumns: preview.missingColumns,
          rules,
        },
      });
    },
  );

  /* ------------------------------------------------------------------ *
   * Trigger / re-run
   * ------------------------------------------------------------------ */
  app.post('/api/jobs/:id/process', { preHandler: requireRole('admin', 'hr') }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;
    if (job.status === 'processing' || job.status === 'queued') {
      return reply.code(409).send({ error: 'already_running', message: 'This job is already in the queue' });
    }
    await queue.enqueue(job.id, job.org_id);
    await recordEvent(db, {
      orgId: job.org_id,
      jobId: job.id,
      correlationId: job.correlation_id,
      event: 'job.enqueued',
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
    const metrics = await reaggregateJob(db, job.id);
    return reply.send({ ok: true, metrics });
  });

  /** Correct an employee's hourly rate for a job and rebuild payroll. */
  app.patch(
    '/api/jobs/:id/employees/:code/rate',
    { preHandler: requireRole('admin', 'hr') },
    async (req, reply) => {
      const job = await requireJob(db, req, reply);
      if (!job) return;
      const parsed = z.object({ hourlyRate: z.number().positive().max(100000) }).safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: 'hourlyRate must be a positive number' });
      }
      const code = (req.params as any).code as string;

      const { rows: jobRules } = await db.query<{ rules: any }>('SELECT rules FROM jobs WHERE id = $1', [
        job.id,
      ]);
      const { rows: orgRules } = await db.query<any>(
        'SELECT ot_multiplier FROM organizations WHERE id = $1',
        [job.org_id],
      );
      const multiplier = Number(jobRules[0]?.rules?.multiplier ?? orgRules[0]?.ot_multiplier ?? 1.5);

      const { rowCount } = await db.query(
        `UPDATE timesheet_rows
         SET hourly_rate = $3::numeric,
             gross_pay = ROUND((regular_hours * $3::numeric + overtime_hours * $3::numeric * $4::numeric)::numeric, 2)
         WHERE job_id = $1 AND employee_code = $2 AND status = 'valid'`,
        [job.id, code, parsed.data.hourlyRate, multiplier],
      );
      if (!rowCount) {
        return reply.code(404).send({ error: 'not_found', message: 'No valid rows for that employee' });
      }

      await recordEvent(db, {
        orgId: job.org_id,
        jobId: job.id,
        correlationId: job.correlation_id,
        level: 'warn',
        event: 'payroll.rate_corrected',
        message: `${req.auth!.email} corrected ${code} to ${parsed.data.hourlyRate}/h across ${rowCount} row(s)`,
        data: { employeeCode: code, hourlyRate: parsed.data.hourlyRate, rows: rowCount },
        broadcast: true,
      });

      const metrics = await reaggregateJob(db, job.id);
      return reply.send({ ok: true, updatedRows: rowCount, metrics });
    },
  );

  /* ------------------------------------------------------------------ *
   * Reads
   * ------------------------------------------------------------------ */
  app.get('/api/jobs', { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = int(q.limit, 25, 1, 100);
    const offset = int(q.offset, 0, 0, 1_000_000);
    const { rows } = await db.query(
      `SELECT j.id, j.filename, j.status, j.stage, j.total_rows, j.processed_rows, j.valid_rows,
              j.invalid_rows, j.duplicate_rows, j.period_start, j.period_end, j.correlation_id,
              j.duration_ms, j.avg_row_ms, j.created_at, j.finished_at, j.error, j.rules,
              u.name AS uploaded_by_name,
              COALESCE(r.metrics->'totals'->>'grossPay', '0') AS gross_pay
       FROM jobs j
       LEFT JOIN users u ON u.id = j.uploaded_by
       LEFT JOIN payroll_reports r ON r.job_id = j.id
       WHERE j.org_id = $1
       ORDER BY j.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.auth!.orgId, limit, offset],
    );
    const { rows: countRows } = await db.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM jobs WHERE org_id = $1',
      [req.auth!.orgId],
    );
    return reply.send({ jobs: rows, total: countRows[0].n, limit, offset });
  });

  app.get('/api/jobs/:id', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;
    const { rows } = await db.query(
      `SELECT j.*, u.name AS uploaded_by_name, u.email AS uploaded_by_email
       FROM jobs j LEFT JOIN users u ON u.id = j.uploaded_by WHERE j.id = $1`,
      [job.id],
    );
    const { rows: reportRows } = await db.query(
      'SELECT metrics, generated_at, computed_ms FROM payroll_reports WHERE job_id = $1',
      [job.id],
    );
    return reply.send({
      job: rows[0],
      metrics: reportRows[0]?.metrics ?? null,
      report: reportRows[0]
        ? { generatedAt: reportRows[0].generated_at, computedMs: reportRows[0].computed_ms }
        : null,
    });
  });

  app.get('/api/jobs/:id/metrics', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;
    const { rows } = await db.query('SELECT metrics FROM payroll_reports WHERE job_id = $1', [job.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found', message: 'No report for this job yet' });
    return reply.send({ metrics: rows[0].metrics });
  });

  /** Raw rows with their validation verdict — the "annotated results" view. */
  app.get('/api/jobs/:id/rows', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;
    const q = req.query as Record<string, string>;
    const limit = int(q.limit, 50, 1, 500);
    const offset = int(q.offset, 0, 0, 1_000_000);

    const where: string[] = ['job_id = $1'];
    const params: any[] = [job.id];
    if (q.status && ['valid', 'invalid', 'duplicate'].includes(q.status)) {
      params.push(q.status);
      where.push(`status = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      where.push(
        `(LOWER(COALESCE(employee_code,'')) LIKE $${params.length} OR LOWER(COALESCE(employee_name,'')) LIKE $${params.length} OR LOWER(COALESCE(department,'')) LIKE $${params.length})`,
      );
    }
    const scoped = scopeEmployeeCode(req.auth!);
    if (scoped) {
      params.push(scoped);
      where.push(`employee_code = $${params.length}`);
    }
    const whereSql = where.join(' AND ');

    const { rows } = await db.query(
      `SELECT row_number, employee_code, employee_name, department, work_date, clock_in, clock_out,
              hourly_rate, status, errors, hours_worked, regular_hours, overtime_hours, gross_pay,
              iso_week, attempts, processing_ms
       FROM timesheet_rows WHERE ${whereSql}
       ORDER BY row_number ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const { rows: countRows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM timesheet_rows WHERE ${whereSql}`,
      params,
    );
    return reply.send({ rows, total: countRows[0].n, limit, offset });
  });

  /** Payroll table: one line per employee, sortable + searchable. */
  const PAYROLL_SORTS: Record<string, string> = {
    employee: 'employee_name',
    code: 'employee_code',
    department: 'department',
    regular: 'regular_hours',
    overtime: 'overtime_hours',
    total: 'total_hours',
    rate: 'hourly_rate',
    gross: 'gross_pay',
    days: 'days_worked',
  };

  app.get('/api/jobs/:id/payroll', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;
    const q = req.query as Record<string, string>;
    const limit = int(q.limit, 50, 1, 500);
    const offset = int(q.offset, 0, 0, 1_000_000);
    const sort = PAYROLL_SORTS[q.sort ?? 'gross'] ?? 'gross_pay';
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';

    const where = ['job_id = $1'];
    const params: any[] = [job.id];
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      where.push(
        `(LOWER(employee_code) LIKE $${params.length} OR LOWER(employee_name) LIKE $${params.length})`,
      );
    }
    if (q.department && q.department !== 'all') {
      params.push(q.department);
      where.push(`department = $${params.length}`);
    }
    const scoped = scopeEmployeeCode(req.auth!);
    if (scoped) {
      params.push(scoped);
      where.push(`employee_code = $${params.length}`);
    }
    const whereSql = where.join(' AND ');

    const { rows } = await db.query(
      `SELECT employee_code, employee_name, department, days_worked, regular_hours, overtime_hours,
              total_hours, avg_daily_hours, hourly_rate, regular_pay, overtime_pay, gross_pay
       FROM payroll_lines WHERE ${whereSql}
       ORDER BY ${sort} ${dir}, employee_code ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const { rows: countRows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payroll_lines WHERE ${whereSql}`,
      params,
    );
    return reply.send({ rows, total: countRows[0].n, limit, offset, sort: q.sort ?? 'gross', dir });
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

  /* ------------------------------------------------------------------ *
   * Exports
   * ------------------------------------------------------------------ */
  app.get('/api/jobs/:id/export/annotated.csv', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;
    const scoped = scopeEmployeeCode(req.auth!);
    const { rows } = await db.query<any>(
      `SELECT row_number, employee_code, employee_name, department, work_date, clock_in, clock_out,
              hourly_rate, status, errors, hours_worked, regular_hours, overtime_hours, gross_pay
       FROM timesheet_rows
       WHERE job_id = $1 ${scoped ? 'AND employee_code = $2' : ''}
       ORDER BY row_number ASC`,
      scoped ? [job.id, scoped] : [job.id],
    );

    const csv = toCsv(
      [
        'row_number',
        'employee_id',
        'employee_name',
        'department',
        'date',
        'clock_in',
        'clock_out',
        'hourly_rate',
        'status',
        'error_codes',
        'error_messages',
        'hours_worked',
        'regular_hours',
        'overtime_hours',
        'gross_pay',
      ],
      rows.map((r) => {
        const errors = Array.isArray(r.errors) ? r.errors : JSON.parse(r.errors ?? '[]');
        return [
          r.row_number,
          r.employee_code,
          r.employee_name,
          r.department,
          r.work_date ? String(r.work_date).slice(0, 10) : '',
          r.clock_in,
          r.clock_out,
          r.hourly_rate,
          r.status,
          errors.map((e: any) => e.code).join('|'),
          errors.map((e: any) => e.message).join(' | '),
          r.hours_worked,
          r.regular_hours,
          r.overtime_hours,
          r.gross_pay,
        ];
      }),
    );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="annotated-${job.id.slice(0, 8)}.csv"`)
      .send(csv);
  });

  app.get('/api/jobs/:id/export/payroll.csv', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;
    const scoped = scopeEmployeeCode(req.auth!);
    const { rows } = await db.query<any>(
      `SELECT employee_code, employee_name, department, days_worked, regular_hours, overtime_hours,
              total_hours, hourly_rate, regular_pay, overtime_pay, gross_pay
       FROM payroll_lines WHERE job_id = $1 ${scoped ? 'AND employee_code = $2' : ''}
       ORDER BY employee_name ASC`,
      scoped ? [job.id, scoped] : [job.id],
    );
    const csv = toCsv(
      [
        'employee_id',
        'employee_name',
        'department',
        'days_worked',
        'regular_hours',
        'overtime_hours',
        'total_hours',
        'hourly_rate',
        'regular_pay',
        'overtime_pay',
        'gross_pay',
      ],
      rows.map((r) => [
        r.employee_code,
        r.employee_name,
        r.department,
        r.days_worked,
        r.regular_hours,
        r.overtime_hours,
        r.total_hours,
        r.hourly_rate,
        r.regular_pay,
        r.overtime_pay,
        r.gross_pay,
      ]),
    );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="payroll-${job.id.slice(0, 8)}.csv"`)
      .send(csv);
  });
}

export { loadJob };
