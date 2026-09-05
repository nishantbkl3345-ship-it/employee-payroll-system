import type { Db } from '../db/index.js';
import type { OvertimeRules } from './types.js';

/* Aggregation runs in SQL rather than in JS: for a 10k+ row file the database
 * is both faster and bounded in memory, and the same rollup tables then serve
 * cross-job queries such as "this department's payroll for the last 3 periods". */

export interface DepartmentMetric {
  department: string;
  employees: number;
  regularHours: number;
  overtimeHours: number;
  totalHours: number;
  regularPay: number;
  overtimePay: number;
  grossPay: number;
  overtimePct: number;
}

export interface WeeklyMetric {
  isoWeek: string;
  weekStart: string;
  regularHours: number;
  overtimeHours: number;
  grossPay: number;
  overtimePay: number;
  employees: number;
  changePct: number | null;
}

export interface PayrollMetrics {
  rules: OvertimeRules;
  totals: {
    grossPay: number;
    regularPay: number;
    overtimePay: number;
    regularHours: number;
    overtimeHours: number;
    totalHours: number;
    employees: number;
    daysWorked: number;
    avgHoursPerEmployee: number;
    avgShiftHours: number;
    overtimePctOfPayroll: number;
    overtimeHoursPct: number;
    stddevShiftHours: number;
    stddevEmployeeHours: number;
  };
  byDepartment: DepartmentMetric[];
  topOvertime: Array<{
    employeeCode: string;
    employeeName: string;
    department: string;
    overtimeHours: number;
    overtimePay: number;
    totalHours: number;
  }>;
  irregularSchedules: Array<{
    employeeCode: string;
    employeeName: string;
    department: string;
    shifts: number;
    avgShiftHours: number;
    stddevShiftHours: number;
  }>;
  weekly: WeeklyMetric[];
  quality: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRows: number;
    validPct: number;
    errorBreakdown: Array<{ code: string; count: number }>;
  };
  period: { start: string | null; end: string | null };
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;
const pct = (part: number, whole: number): number => (whole > 0 ? r2((part / whole) * 100) : 0);

/**
 * Rebuilds every derived table for a job: payroll_lines, payroll_weekly and the
 * materialised metrics document. Safe to re-run at any time (idempotent), which
 * is what powers the "re-run payroll" action after a rate correction.
 */
export async function aggregateJob(
  db: Db,
  jobId: string,
  orgId: string,
  rules: OvertimeRules,
): Promise<{ metrics: PayrollMetrics; computedMs: number }> {
  const startedAt = performance.now();
  const mult = rules.multiplier;

  await db.query('DELETE FROM payroll_lines WHERE job_id = $1', [jobId]);
  await db.query('DELETE FROM payroll_weekly WHERE job_id = $1', [jobId]);

  await db.query(
    `INSERT INTO payroll_lines
       (job_id, org_id, employee_code, employee_name, department, days_worked,
        regular_hours, overtime_hours, total_hours, avg_daily_hours, hourly_rate,
        regular_pay, overtime_pay, gross_pay)
     SELECT
       $1, $2,
       employee_code,
       MAX(employee_name),
       MAX(department),
       COUNT(DISTINCT work_date),
       ROUND(SUM(regular_hours)::numeric, 2),
       ROUND(SUM(overtime_hours)::numeric, 2),
       ROUND(SUM(hours_worked)::numeric, 2),
       ROUND((SUM(hours_worked) / NULLIF(COUNT(DISTINCT work_date), 0))::numeric, 2),
       MAX(hourly_rate),
       ROUND(SUM(regular_hours * hourly_rate)::numeric, 2),
       ROUND(SUM(overtime_hours * hourly_rate * $3::numeric)::numeric, 2),
       ROUND(SUM(gross_pay)::numeric, 2)
     FROM timesheet_rows
     WHERE job_id = $1 AND status = 'valid'
     GROUP BY employee_code`,
    [jobId, orgId, mult],
  );

  // Company-wide weekly rollup (department '*') plus one row per department.
  await db.query(
    `INSERT INTO payroll_weekly
       (job_id, org_id, iso_week, week_start, department,
        regular_hours, overtime_hours, gross_pay, overtime_pay, employee_count)
     SELECT $1, $2, iso_week, week_start, '*',
       ROUND(SUM(regular_hours)::numeric, 2),
       ROUND(SUM(overtime_hours)::numeric, 2),
       ROUND(SUM(gross_pay)::numeric, 2),
       ROUND(SUM(overtime_hours * hourly_rate * $3::numeric)::numeric, 2),
       COUNT(DISTINCT employee_code)
     FROM timesheet_rows
     WHERE job_id = $1 AND status = 'valid' AND iso_week IS NOT NULL
     GROUP BY iso_week, week_start`,
    [jobId, orgId, mult],
  );
  await db.query(
    `INSERT INTO payroll_weekly
       (job_id, org_id, iso_week, week_start, department,
        regular_hours, overtime_hours, gross_pay, overtime_pay, employee_count)
     SELECT $1, $2, iso_week, week_start, department,
       ROUND(SUM(regular_hours)::numeric, 2),
       ROUND(SUM(overtime_hours)::numeric, 2),
       ROUND(SUM(gross_pay)::numeric, 2),
       ROUND(SUM(overtime_hours * hourly_rate * $3::numeric)::numeric, 2),
       COUNT(DISTINCT employee_code)
     FROM timesheet_rows
     WHERE job_id = $1 AND status = 'valid' AND iso_week IS NOT NULL
     GROUP BY iso_week, week_start, department`,
    [jobId, orgId, mult],
  );

  const [totalsQ, deptQ, topQ, irregularQ, weeklyQ, qualityQ, errorsQ, periodQ, shiftQ] =
    await Promise.all([
      db.query(
        `SELECT
           COALESCE(SUM(gross_pay), 0)      AS gross_pay,
           COALESCE(SUM(regular_pay), 0)    AS regular_pay,
           COALESCE(SUM(overtime_pay), 0)   AS overtime_pay,
           COALESCE(SUM(regular_hours), 0)  AS regular_hours,
           COALESCE(SUM(overtime_hours), 0) AS overtime_hours,
           COALESCE(SUM(total_hours), 0)    AS total_hours,
           COALESCE(SUM(days_worked), 0)    AS days_worked,
           COUNT(*)                         AS employees,
           COALESCE(STDDEV_SAMP(total_hours), 0) AS stddev_employee_hours
         FROM payroll_lines WHERE job_id = $1`,
        [jobId],
      ),
      db.query(
        `SELECT department,
                COUNT(*)                         AS employees,
                COALESCE(SUM(regular_hours), 0)  AS regular_hours,
                COALESCE(SUM(overtime_hours), 0) AS overtime_hours,
                COALESCE(SUM(total_hours), 0)    AS total_hours,
                COALESCE(SUM(regular_pay), 0)    AS regular_pay,
                COALESCE(SUM(overtime_pay), 0)   AS overtime_pay,
                COALESCE(SUM(gross_pay), 0)      AS gross_pay
         FROM payroll_lines WHERE job_id = $1
         GROUP BY department ORDER BY gross_pay DESC`,
        [jobId],
      ),
      db.query(
        `SELECT employee_code, employee_name, department, overtime_hours, overtime_pay, total_hours
         FROM payroll_lines WHERE job_id = $1 AND overtime_hours > 0
         ORDER BY overtime_hours DESC, employee_code ASC LIMIT 5`,
        [jobId],
      ),
      db.query(
        `SELECT employee_code,
                MAX(employee_name) AS employee_name,
                MAX(department)    AS department,
                COUNT(*)           AS shifts,
                AVG(hours_worked)  AS avg_shift_hours,
                COALESCE(STDDEV_SAMP(hours_worked), 0) AS stddev_shift_hours
         FROM timesheet_rows
         WHERE job_id = $1 AND status = 'valid'
         GROUP BY employee_code
         HAVING COUNT(*) >= 3
         ORDER BY 6 DESC, employee_code ASC LIMIT 5`,
        [jobId],
      ),
      db.query(
        `SELECT iso_week, week_start, regular_hours, overtime_hours, gross_pay, overtime_pay, employee_count
         FROM payroll_weekly WHERE job_id = $1 AND department = '*'
         ORDER BY week_start ASC`,
        [jobId],
      ),
      db.query(
        `SELECT status, COUNT(*) AS count FROM timesheet_rows WHERE job_id = $1 GROUP BY status`,
        [jobId],
      ),
      db.query(
        `SELECT e->>'code' AS code, COUNT(*) AS count
         FROM timesheet_rows, jsonb_array_elements(errors) e
         WHERE job_id = $1
         GROUP BY 1 ORDER BY 2 DESC`,
        [jobId],
      ),
      db.query(
        `SELECT MIN(work_date) AS start, MAX(work_date) AS "end"
         FROM timesheet_rows WHERE job_id = $1 AND status = 'valid' AND work_date IS NOT NULL`,
        [jobId],
      ),
      db.query(
        `SELECT COALESCE(AVG(hours_worked), 0) AS avg_shift_hours,
                COALESCE(STDDEV_SAMP(hours_worked), 0) AS stddev_shift_hours
         FROM timesheet_rows WHERE job_id = $1 AND status = 'valid'`,
        [jobId],
      ),
    ]);

  const t = totalsQ.rows[0] ?? {};
  const shift = shiftQ.rows[0] ?? {};
  const grossPay = r2(n(t.gross_pay));
  const overtimePay = r2(n(t.overtime_pay));
  const totalHours = r2(n(t.total_hours));
  const employees = n(t.employees);

  const statusCounts = Object.fromEntries(qualityQ.rows.map((r: any) => [r.status, n(r.count)]));
  const validRows = statusCounts.valid ?? 0;
  const invalidRows = statusCounts.invalid ?? 0;
  const duplicateRows = statusCounts.duplicate ?? 0;
  const totalRows = validRows + invalidRows + duplicateRows;

  const weekly: WeeklyMetric[] = weeklyQ.rows.map((row: any, i: number, all: any[]) => {
    const prev = i > 0 ? n(all[i - 1].gross_pay) : null;
    const gross = r2(n(row.gross_pay));
    return {
      isoWeek: row.iso_week,
      weekStart: String(row.week_start).slice(0, 10),
      regularHours: r2(n(row.regular_hours)),
      overtimeHours: r2(n(row.overtime_hours)),
      grossPay: gross,
      overtimePay: r2(n(row.overtime_pay)),
      employees: n(row.employee_count),
      changePct: prev && prev > 0 ? r2(((gross - prev) / prev) * 100) : null,
    };
  });

  const metrics: PayrollMetrics = {
    rules,
    totals: {
      grossPay,
      regularPay: r2(n(t.regular_pay)),
      overtimePay,
      regularHours: r2(n(t.regular_hours)),
      overtimeHours: r2(n(t.overtime_hours)),
      totalHours,
      employees,
      daysWorked: n(t.days_worked),
      avgHoursPerEmployee: employees > 0 ? r2(totalHours / employees) : 0,
      avgShiftHours: r2(n(shift.avg_shift_hours)),
      overtimePctOfPayroll: pct(overtimePay, grossPay),
      overtimeHoursPct: pct(n(t.overtime_hours), totalHours),
      stddevShiftHours: r2(n(shift.stddev_shift_hours)),
      stddevEmployeeHours: r2(n(t.stddev_employee_hours)),
    },
    byDepartment: deptQ.rows.map((row: any) => ({
      department: row.department,
      employees: n(row.employees),
      regularHours: r2(n(row.regular_hours)),
      overtimeHours: r2(n(row.overtime_hours)),
      totalHours: r2(n(row.total_hours)),
      regularPay: r2(n(row.regular_pay)),
      overtimePay: r2(n(row.overtime_pay)),
      grossPay: r2(n(row.gross_pay)),
      overtimePct: pct(n(row.overtime_pay), n(row.gross_pay)),
    })),
    topOvertime: topQ.rows.map((row: any) => ({
      employeeCode: row.employee_code,
      employeeName: row.employee_name,
      department: row.department,
      overtimeHours: r2(n(row.overtime_hours)),
      overtimePay: r2(n(row.overtime_pay)),
      totalHours: r2(n(row.total_hours)),
    })),
    irregularSchedules: irregularQ.rows.map((row: any) => ({
      employeeCode: row.employee_code,
      employeeName: row.employee_name,
      department: row.department,
      shifts: n(row.shifts),
      avgShiftHours: r2(n(row.avg_shift_hours)),
      stddevShiftHours: r2(n(row.stddev_shift_hours)),
    })),
    weekly,
    quality: {
      totalRows,
      validRows,
      invalidRows,
      duplicateRows,
      validPct: pct(validRows, totalRows),
      errorBreakdown: errorsQ.rows.map((row: any) => ({ code: row.code, count: n(row.count) })),
    },
    period: {
      start: periodQ.rows[0]?.start ? String(periodQ.rows[0].start).slice(0, 10) : null,
      end: periodQ.rows[0]?.end ? String(periodQ.rows[0].end).slice(0, 10) : null,
    },
  };

  const computedMs = performance.now() - startedAt;

  await db.query(
    `INSERT INTO payroll_reports (job_id, org_id, period_start, period_end, metrics, computed_ms, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (job_id) DO UPDATE
       SET period_start = EXCLUDED.period_start,
           period_end   = EXCLUDED.period_end,
           metrics      = EXCLUDED.metrics,
           computed_ms  = EXCLUDED.computed_ms,
           generated_at = now()`,
    [jobId, orgId, metrics.period.start, metrics.period.end, JSON.stringify(metrics), computedMs],
  );

  await db.query(
    `UPDATE jobs SET valid_rows = $2, invalid_rows = $3, duplicate_rows = $4,
                     period_start = $5, period_end = $6
     WHERE id = $1`,
    [jobId, validRows, invalidRows, duplicateRows, metrics.period.start, metrics.period.end],
  );

  return { metrics, computedMs };
}
