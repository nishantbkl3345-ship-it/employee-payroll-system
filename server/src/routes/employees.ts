import type { App } from '../http.js';
import { canSeeEveryone, requireAuth, scopeEmployeeCode } from '../auth/index.js';
import type { Db } from '../db/index.js';
import { toCsv } from '../lib/csv.js';

const day = (v: unknown): string => (v ? String(v).slice(0, 10) : '');

/** Resolves the job to report on: an explicit ?jobId=, else the latest completed job. */
async function resolveJobId(db: Db, orgId: string, requested?: string): Promise<string | null> {
  if (requested && /^[0-9a-f-]{36}$/i.test(requested)) {
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

export function registerEmployeeRoutes(app: App, db: Db): void {
  /** Employee directory for the organisation. */
  app.get('/api/employees', { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    const scoped = scopeEmployeeCode(req.auth!);
    const params: any[] = [req.auth!.orgId];
    let where = 'org_id = $1';
    if (scoped) {
      params.push(scoped);
      where += ` AND employee_code = $${params.length}`;
    }
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      where += ` AND (LOWER(employee_code) LIKE $${params.length} OR LOWER(name) LIKE $${params.length})`;
    }
    const { rows } = await db.query(
      `SELECT employee_code, name, department FROM employees WHERE ${where} ORDER BY name ASC LIMIT 500`,
      params,
    );
    return reply.send({ employees: rows });
  });

  app.get('/api/departments', { preHandler: requireAuth }, async (req, reply) => {
    const { rows } = await db.query(
      'SELECT DISTINCT department FROM employees WHERE org_id = $1 ORDER BY department ASC',
      [req.auth!.orgId],
    );
    return reply.send({ departments: rows.map((r: any) => r.department) });
  });

  /** Day-by-day timesheet detail plus the payroll line for one employee. */
  app.get('/api/employees/:code/timesheet', { preHandler: requireAuth }, async (req, reply) => {
    const code = (req.params as any).code as string;
    const scoped = scopeEmployeeCode(req.auth!);
    if (scoped && scoped !== code) {
      return reply.code(403).send({ error: 'forbidden', message: 'You can only view your own timesheet' });
    }

    const jobId = await resolveJobId(db, req.auth!.orgId, (req.query as any).jobId);
    if (!jobId) return reply.code(404).send({ error: 'not_found', message: 'No processed payroll job yet' });

    const [lineQ, rowsQ, jobQ, weeklyQ] = await Promise.all([
      db.query(
        `SELECT employee_code, employee_name, department, days_worked, regular_hours, overtime_hours,
                total_hours, avg_daily_hours, hourly_rate, regular_pay, overtime_pay, gross_pay
         FROM payroll_lines WHERE job_id = $1 AND employee_code = $2`,
        [jobId, code],
      ),
      db.query(
        `SELECT row_number, work_date, clock_in, clock_out, hourly_rate, status, errors,
                hours_worked, regular_hours, overtime_hours, gross_pay, iso_week
         FROM timesheet_rows WHERE job_id = $1 AND employee_code = $2
         ORDER BY work_date ASC NULLS LAST, clock_in ASC, row_number ASC`,
        [jobId, code],
      ),
      db.query(
        'SELECT id, filename, period_start, period_end, status, created_at FROM jobs WHERE id = $1',
        [jobId],
      ),
      db.query(
        `SELECT iso_week, MIN(week_start) AS week_start,
                ROUND(SUM(regular_hours)::numeric, 2) AS regular_hours,
                ROUND(SUM(overtime_hours)::numeric, 2) AS overtime_hours,
                ROUND(SUM(gross_pay)::numeric, 2) AS gross_pay
         FROM timesheet_rows
         WHERE job_id = $1 AND employee_code = $2 AND status = 'valid' AND iso_week IS NOT NULL
         GROUP BY iso_week ORDER BY 2 ASC`,
        [jobId, code],
      ),
    ]);

    if (!rowsQ.rows.length) {
      return reply.code(404).send({ error: 'not_found', message: 'No rows for that employee in this job' });
    }

    return reply.send({
      job: jobQ.rows[0],
      summary: lineQ.rows[0] ?? null,
      days: rowsQ.rows,
      weeks: weeklyQ.rows,
    });
  });

  /** Payslip export for one employee (CSV; the UI also renders a printable view). */
  app.get('/api/employees/:code/payslip.csv', { preHandler: requireAuth }, async (req, reply) => {
    const code = (req.params as any).code as string;
    const scoped = scopeEmployeeCode(req.auth!);
    if (scoped && scoped !== code) {
      return reply.code(403).send({ error: 'forbidden', message: 'You can only download your own payslip' });
    }
    const jobId = await resolveJobId(db, req.auth!.orgId, (req.query as any).jobId);
    if (!jobId) return reply.code(404).send({ error: 'not_found', message: 'No processed payroll job yet' });

    const [orgQ, jobQ, lineQ, rowsQ] = await Promise.all([
      db.query<any>('SELECT name FROM organizations WHERE id = $1', [req.auth!.orgId]),
      db.query<any>('SELECT filename, period_start, period_end FROM jobs WHERE id = $1', [jobId]),
      db.query<any>('SELECT * FROM payroll_lines WHERE job_id = $1 AND employee_code = $2', [jobId, code]),
      db.query<any>(
        `SELECT work_date, clock_in, clock_out, hours_worked, regular_hours, overtime_hours, hourly_rate, gross_pay
         FROM timesheet_rows WHERE job_id = $1 AND employee_code = $2 AND status = 'valid'
         ORDER BY work_date ASC, clock_in ASC`,
        [jobId, code],
      ),
    ]);
    const line = lineQ.rows[0];
    if (!line) return reply.code(404).send({ error: 'not_found', message: 'No payroll line for that employee' });

    const job = jobQ.rows[0];
    const header: unknown[][] = [
      ['Payslip', orgQ.rows[0]?.name ?? ''],
      ['Employee', `${line.employee_name} (${line.employee_code})`],
      ['Department', line.department],
      ['Pay period', `${day(job.period_start)} to ${day(job.period_end)}`],
      ['Source file', job.filename],
      [],
      ['Earnings', 'Hours', 'Rate', 'Amount'],
      ['Regular', line.regular_hours, line.hourly_rate, line.regular_pay],
      ['Overtime', line.overtime_hours, `${line.hourly_rate} x mult`, line.overtime_pay],
      ['Gross pay', line.total_hours, '', line.gross_pay],
      [],
      ['Date', 'Clock in', 'Clock out', 'Hours', 'Regular', 'Overtime', 'Rate', 'Pay'],
      ...rowsQ.rows.map((r: any) => [
        day(r.work_date),
        r.clock_in,
        r.clock_out,
        r.hours_worked,
        r.regular_hours,
        r.overtime_hours,
        r.hourly_rate,
        r.gross_pay,
      ]),
    ];

    const csv = toCsv([], header).replace(/^﻿\r\n/, '﻿');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="payslip-${code}-${day(job.period_end)}.csv"`)
      .send(csv);
  });

  /** Convenience endpoint for the employee role: "my payslip". */
  app.get('/api/me/payslip', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.auth!;
    const code = canSeeEveryone(user) ? ((req.query as any).code as string) : user.employeeCode;
    if (!code) {
      return reply.code(404).send({
        error: 'no_employee_link',
        message: 'This account is not linked to an employee record yet',
      });
    }
    const jobId = await resolveJobId(db, user.orgId, (req.query as any).jobId);
    if (!jobId) return reply.code(404).send({ error: 'not_found', message: 'No processed payroll job yet' });
    const { rows } = await db.query('SELECT * FROM payroll_lines WHERE job_id = $1 AND employee_code = $2', [
      jobId,
      code,
    ]);
    return reply.send({ jobId, employeeCode: code, line: rows[0] ?? null });
  });
}
