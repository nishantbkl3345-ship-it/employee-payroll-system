import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth, restrictToOwnEmployeeCode } from '../auth/index.js';
import type { Db } from '../db/index.js';
import { annotatedTimesheetCsv, payrollSummaryCsv } from '../payroll/csv.js';
import { requireJob } from './params.js';

export function registerExportRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/jobs/:id/export/annotated.csv', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;

    const ownCode = restrictToOwnEmployeeCode(req.auth!);
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT row_number, employee_code, employee_name, department, work_date, clock_in, clock_out,
              hourly_rate, status, errors, hours_worked, regular_hours, overtime_hours,
              regular_pay, overtime_pay, gross_pay
       FROM timesheet_rows
       WHERE job_id = $1 ${ownCode ? 'AND employee_code = $2' : ''}
       ORDER BY row_number ASC`,
      ownCode ? [job.id, ownCode] : [job.id],
    );

    return sendCsv(reply, `annotated-${job.id.slice(0, 8)}.csv`, annotatedTimesheetCsv(rows));
  });

  app.get('/api/jobs/:id/export/payroll.csv', { preHandler: requireAuth }, async (req, reply) => {
    const job = await requireJob(db, req, reply);
    if (!job) return;

    const ownCode = restrictToOwnEmployeeCode(req.auth!);
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT employee_code, employee_name, department, days_worked, regular_hours, overtime_hours,
              total_hours, hourly_rate, regular_pay, overtime_pay, gross_pay
       FROM payroll_lines
       WHERE job_id = $1 ${ownCode ? 'AND employee_code = $2' : ''}
       ORDER BY employee_name ASC`,
      ownCode ? [job.id, ownCode] : [job.id],
    );

    return sendCsv(reply, `payroll-${job.id.slice(0, 8)}.csv`, payrollSummaryCsv(rows));
  });
}

export function sendCsv(reply: FastifyReply, filename: string, csv: string): FastifyReply {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename}"`)
    .send(csv);
}
