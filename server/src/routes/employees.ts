import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, restrictToOwnEmployeeCode } from '../auth/index.js';
import type { Db } from '../db/index.js';
import { payslipCsv } from '../payroll/csv.js';
import { sendCsv } from './exports.js';
import { isUuid } from './params.js';

const DIRECTORY_LIMIT = 500;

/** The pay run to report on: an explicit ?jobId=, else the latest completed one. */
async function resolveJobId(db: Db, orgId: string, requested?: string): Promise<string | null> {
  if (isUuid(requested)) {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM jobs WHERE id = $1 AND org_id = $2',
      [requested, orgId],
    );
    return rows[0]?.id ?? null;
  }

  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM jobs WHERE org_id = $1 AND status = 'completed'
     ORDER BY COALESCE(period_end, created_at::date) DESC, created_at DESC LIMIT 1`,
    [orgId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Resolves the employee and pay run a request is about, rejecting an
 * employee-role caller asking about somebody else. Both employee endpoints go
 * through here so that check cannot drift between them.
 */
async function resolveEmployeeRequest(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ employeeCode: string; jobId: string } | null> {
  const { code } = req.params as { code: string };
  const ownCode = restrictToOwnEmployeeCode(req.auth!);

  if (ownCode && ownCode !== code) {
    await reply
      .code(403)
      .send({ error: 'forbidden', message: 'You can only view your own payroll records' });
    return null;
  }

  const jobId = await resolveJobId(db, req.auth!.orgId, (req.query as { jobId?: string }).jobId);
  if (!jobId) {
    await reply.code(404).send({ error: 'not_found', message: 'No processed pay run yet' });
    return null;
  }

  return { employeeCode: code, jobId };
}

export function registerEmployeeRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/employees', { preHandler: requireAuth }, async (req, reply) => {
    const { q } = req.query as { q?: string };
    const ownCode = restrictToOwnEmployeeCode(req.auth!);

    const filters = ['org_id = $1'];
    const params: unknown[] = [req.auth!.orgId];

    if (ownCode) {
      params.push(ownCode);
      filters.push(`employee_code = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      filters.push(`(LOWER(employee_code) LIKE $${params.length} OR LOWER(name) LIKE $${params.length})`);
    }

    const { rows } = await db.query(
      `SELECT employee_code, name, department
       FROM employees WHERE ${filters.join(' AND ')}
       ORDER BY name ASC LIMIT $${params.length + 1}`,
      [...params, DIRECTORY_LIMIT],
    );
    return reply.send({ employees: rows });
  });

  app.get('/api/departments', { preHandler: requireAuth }, async (req, reply) => {
    const { rows } = await db.query<{ department: string }>(
      'SELECT DISTINCT department FROM employees WHERE org_id = $1 ORDER BY department ASC',
      [req.auth!.orgId],
    );
    return reply.send({ departments: rows.map((row) => row.department) });
  });

  /** Day-by-day detail plus the payroll line for one employee in one pay run. */
  app.get('/api/employees/:code/timesheet', { preHandler: requireAuth }, async (req, reply) => {
    const request = await resolveEmployeeRequest(db, req, reply);
    if (!request) return;
    const { employeeCode, jobId } = request;

    const [payrollLine, shifts, job, weeks] = await Promise.all([
      db.query(
        `SELECT employee_code, employee_name, department, days_worked, regular_hours, overtime_hours,
                total_hours, avg_daily_hours, hourly_rate, regular_pay, overtime_pay, gross_pay
         FROM payroll_lines WHERE job_id = $1 AND employee_code = $2`,
        [jobId, employeeCode],
      ),
      db.query(
        `SELECT row_number, work_date, clock_in, clock_out, hourly_rate, status, errors, hours_worked,
                regular_hours, overtime_hours, regular_pay, overtime_pay, gross_pay, iso_week
         FROM timesheet_rows WHERE job_id = $1 AND employee_code = $2
         ORDER BY work_date ASC NULLS LAST, clock_in ASC, row_number ASC`,
        [jobId, employeeCode],
      ),
      db.query(
        'SELECT id, filename, period_start, period_end, status, created_at FROM jobs WHERE id = $1',
        [jobId],
      ),
      db.query(
        `SELECT iso_week, MIN(week_start) AS week_start,
                SUM(regular_hours) AS regular_hours,
                SUM(overtime_hours) AS overtime_hours,
                SUM(gross_pay) AS gross_pay
         FROM timesheet_rows
         WHERE job_id = $1 AND employee_code = $2 AND status = 'valid' AND iso_week IS NOT NULL
         GROUP BY iso_week ORDER BY 2 ASC`,
        [jobId, employeeCode],
      ),
    ]);

    if (!shifts.rows.length) {
      return reply
        .code(404)
        .send({ error: 'not_found', message: 'No rows for that employee in this pay run' });
    }

    return reply.send({
      job: job.rows[0],
      summary: payrollLine.rows[0] ?? null,
      days: shifts.rows,
      weeks: weeks.rows,
    });
  });

  /** Payslip export. The UI renders a printable version of the same figures. */
  app.get('/api/employees/:code/payslip.csv', { preHandler: requireAuth }, async (req, reply) => {
    const request = await resolveEmployeeRequest(db, req, reply);
    if (!request) return;
    const { employeeCode, jobId } = request;

    const [organization, job, payrollLine, shifts] = await Promise.all([
      db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [req.auth!.orgId]),
      db.query<any>('SELECT filename, period_start, period_end FROM jobs WHERE id = $1', [jobId]),
      db.query<any>(
        `SELECT employee_code, employee_name, department, total_hours,
                regular_hours, overtime_hours, regular_pay, overtime_pay, gross_pay
         FROM payroll_lines WHERE job_id = $1 AND employee_code = $2`,
        [jobId, employeeCode],
      ),
      db.query<any>(
        `SELECT work_date, clock_in, clock_out, hours_worked, regular_hours, overtime_hours,
                hourly_rate, gross_pay
         FROM timesheet_rows
         WHERE job_id = $1 AND employee_code = $2 AND status = 'valid'
         ORDER BY work_date ASC, clock_in ASC`,
        [jobId, employeeCode],
      ),
    ]);

    const line = payrollLine.rows[0];
    if (!line) {
      return reply.code(404).send({ error: 'not_found', message: 'No payroll line for that employee' });
    }

    const periodEnd = String(job.rows[0].period_end ?? '').slice(0, 10);
    return sendCsv(
      reply,
      `payslip-${employeeCode}-${periodEnd}.csv`,
      payslipCsv({
        organizationName: organization.rows[0]?.name ?? '',
        job: job.rows[0],
        line,
        days: shifts.rows,
      }),
    );
  });
}
