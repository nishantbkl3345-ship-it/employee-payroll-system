import type { Db } from '../db/index.js';
import type { OvertimeRules } from './types.js';

/**
 * Aggregation runs in SQL: for a 10k+ row file the database is faster and
 * bounded in memory, and the rollup tables it writes also serve cross-job
 * queries like "this department's payroll for the last 3 periods".
 *
 * Pay is only ever summed here, never recalculated — the multiplier lives in
 * the payroll calculator alone, so there is one place to change a pay rule.
 */

/** Department value used for the company-wide row in payroll_weekly. */
const COMPANY_WIDE = '*';
const TOP_OVERTIME_LIMIT = 5;
/** Fewer shifts than this and a standard deviation says nothing useful. */
const MIN_SHIFTS_FOR_SPREAD = 3;

export interface DepartmentPayroll {
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

export interface WeeklyPayroll {
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
  byDepartment: DepartmentPayroll[];
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
  weekly: WeeklyPayroll[];
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

/**
 * Rebuilds every derived table for a job. Idempotent, which is what makes
 * "re-run payroll" safe after a rate correction.
 */
export async function rebuildPayrollReport(
  db: Db,
  jobId: string,
  organizationId: string,
  rules: OvertimeRules,
): Promise<{ metrics: PayrollMetrics; computedMs: number }> {
  const startedAt = performance.now();

  await rebuildEmployeeLines(db, jobId, organizationId);
  await rebuildWeeklyTotals(db, jobId, organizationId);

  const metrics = await readMetrics(db, jobId, rules);
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
    [jobId, organizationId, metrics.period.start, metrics.period.end, JSON.stringify(metrics), computedMs],
  );

  await db.query(
    `UPDATE jobs
     SET valid_rows = $2, invalid_rows = $3, duplicate_rows = $4, period_start = $5, period_end = $6
     WHERE id = $1`,
    [
      jobId,
      metrics.quality.validRows,
      metrics.quality.invalidRows,
      metrics.quality.duplicateRows,
      metrics.period.start,
      metrics.period.end,
    ],
  );

  return { metrics, computedMs };
}

/** One payroll line per employee — the payslip grain. */
async function rebuildEmployeeLines(db: Db, jobId: string, organizationId: string): Promise<void> {
  await db.query('DELETE FROM payroll_lines WHERE job_id = $1', [jobId]);
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
       SUM(regular_hours),
       SUM(overtime_hours),
       SUM(hours_worked),
       ROUND(SUM(hours_worked) / NULLIF(COUNT(DISTINCT work_date), 0), 2),
       MAX(hourly_rate),
       SUM(regular_pay),
       SUM(overtime_pay),
       SUM(gross_pay)
     FROM timesheet_rows
     WHERE job_id = $1 AND status = 'valid'
     GROUP BY employee_code`,
    [jobId, organizationId],
  );
}

/**
 * Weekly rollup, company-wide and per department in one pass. GROUPING SETS
 * gives both grains from a single scan; department '*' is the company total.
 */
async function rebuildWeeklyTotals(db: Db, jobId: string, organizationId: string): Promise<void> {
  await db.query('DELETE FROM payroll_weekly WHERE job_id = $1', [jobId]);
  await db.query(
    `INSERT INTO payroll_weekly
       (job_id, org_id, iso_week, week_start, department,
        regular_hours, overtime_hours, gross_pay, overtime_pay, employee_count)
     SELECT $1, $2, iso_week, week_start, COALESCE(department, $3),
            SUM(regular_hours), SUM(overtime_hours), SUM(gross_pay), SUM(overtime_pay),
            COUNT(DISTINCT employee_code)
     FROM timesheet_rows
     WHERE job_id = $1 AND status = 'valid' AND iso_week IS NOT NULL
     GROUP BY GROUPING SETS ((iso_week, week_start), (iso_week, week_start, department))`,
    [jobId, organizationId, COMPANY_WIDE],
  );
}

async function readMetrics(db: Db, jobId: string, rules: OvertimeRules): Promise<PayrollMetrics> {
  const { totals, period } = await readCompanyTotals(db, jobId);

  return {
    rules,
    totals,
    period,
    byDepartment: await readDepartmentPayroll(db, jobId),
    topOvertime: await readOvertimeLeaders(db, jobId),
    irregularSchedules: await readIrregularSchedules(db, jobId),
    weekly: await readWeeklyPayroll(db, jobId),
    quality: await readDataQuality(db, jobId),
  };
}

async function readCompanyTotals(
  db: Db,
  jobId: string,
): Promise<{ totals: PayrollMetrics['totals']; period: PayrollMetrics['period'] }> {
  const employeeTotals = firstRow(
    await db.query(
      `SELECT COALESCE(SUM(gross_pay), 0)      AS gross_pay,
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
  );

  const shiftSpread = firstRow(
    await db.query(
      `SELECT COALESCE(AVG(hours_worked), 0) AS avg_shift_hours,
              COALESCE(STDDEV_SAMP(hours_worked), 0) AS stddev_shift_hours,
              MIN(work_date) AS period_start,
              MAX(work_date) AS period_end
       FROM timesheet_rows WHERE job_id = $1 AND status = 'valid'`,
      [jobId],
    ),
  );

  const grossPay = money(employeeTotals.gross_pay);
  const overtimePay = money(employeeTotals.overtime_pay);
  const overtimeHours = hours(employeeTotals.overtime_hours);
  const totalHours = hours(employeeTotals.total_hours);
  const employees = count(employeeTotals.employees);

  return {
    totals: {
      grossPay,
      regularPay: money(employeeTotals.regular_pay),
      overtimePay,
      regularHours: hours(employeeTotals.regular_hours),
      overtimeHours,
      totalHours,
      employees,
      daysWorked: count(employeeTotals.days_worked),
      avgHoursPerEmployee: employees > 0 ? hours(totalHours / employees) : 0,
      avgShiftHours: hours(shiftSpread.avg_shift_hours),
      overtimePctOfPayroll: percent(overtimePay, grossPay),
      overtimeHoursPct: percent(overtimeHours, totalHours),
      stddevShiftHours: hours(shiftSpread.stddev_shift_hours),
      stddevEmployeeHours: hours(employeeTotals.stddev_employee_hours),
    },
    period: {
      start: asDate(shiftSpread.period_start),
      end: asDate(shiftSpread.period_end),
    },
  };
}

async function readDepartmentPayroll(db: Db, jobId: string): Promise<DepartmentPayroll[]> {
  const { rows } = await db.query(
    `SELECT department,
            COUNT(*) AS employees,
            SUM(regular_hours) AS regular_hours, SUM(overtime_hours) AS overtime_hours,
            SUM(total_hours) AS total_hours, SUM(regular_pay) AS regular_pay,
            SUM(overtime_pay) AS overtime_pay, SUM(gross_pay) AS gross_pay
     FROM payroll_lines WHERE job_id = $1
     GROUP BY department ORDER BY gross_pay DESC`,
    [jobId],
  );

  return rows.map((row) => ({
    department: row.department,
    employees: count(row.employees),
    regularHours: hours(row.regular_hours),
    overtimeHours: hours(row.overtime_hours),
    totalHours: hours(row.total_hours),
    regularPay: money(row.regular_pay),
    overtimePay: money(row.overtime_pay),
    grossPay: money(row.gross_pay),
    overtimePct: percent(money(row.overtime_pay), money(row.gross_pay)),
  }));
}

async function readOvertimeLeaders(db: Db, jobId: string): Promise<PayrollMetrics['topOvertime']> {
  const { rows } = await db.query(
    `SELECT employee_code, employee_name, department, overtime_hours, overtime_pay, total_hours
     FROM payroll_lines
     WHERE job_id = $1 AND overtime_hours > 0
     ORDER BY overtime_hours DESC, employee_code ASC LIMIT $2`,
    [jobId, TOP_OVERTIME_LIMIT],
  );

  return rows.map((row) => ({
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    department: row.department,
    overtimeHours: hours(row.overtime_hours),
    overtimePay: money(row.overtime_pay),
    totalHours: hours(row.total_hours),
  }));
}

/** Employees whose shift lengths vary the most — a scheduling smell, not a payroll error. */
async function readIrregularSchedules(
  db: Db,
  jobId: string,
): Promise<PayrollMetrics['irregularSchedules']> {
  const { rows } = await db.query(
    `SELECT employee_code,
            MAX(employee_name) AS employee_name,
            MAX(department)    AS department,
            COUNT(*)           AS shifts,
            AVG(hours_worked)  AS avg_shift_hours,
            COALESCE(STDDEV_SAMP(hours_worked), 0) AS stddev_shift_hours
     FROM timesheet_rows
     WHERE job_id = $1 AND status = 'valid'
     GROUP BY employee_code
     HAVING COUNT(*) >= $2
     ORDER BY stddev_shift_hours DESC, employee_code ASC LIMIT $3`,
    [jobId, MIN_SHIFTS_FOR_SPREAD, TOP_OVERTIME_LIMIT],
  );

  return rows.map((row) => ({
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    department: row.department,
    shifts: count(row.shifts),
    avgShiftHours: hours(row.avg_shift_hours),
    stddevShiftHours: hours(row.stddev_shift_hours),
  }));
}

async function readWeeklyPayroll(db: Db, jobId: string): Promise<WeeklyPayroll[]> {
  const { rows } = await db.query(
    `SELECT iso_week, week_start, regular_hours, overtime_hours, gross_pay, overtime_pay, employee_count
     FROM payroll_weekly WHERE job_id = $1 AND department = $2
     ORDER BY week_start ASC`,
    [jobId, COMPANY_WIDE],
  );

  return rows.map((row, index, weeks) => {
    const grossPay = money(row.gross_pay);
    const previousGrossPay = index > 0 ? money(weeks[index - 1].gross_pay) : 0;

    return {
      isoWeek: row.iso_week,
      weekStart: asDate(row.week_start)!,
      regularHours: hours(row.regular_hours),
      overtimeHours: hours(row.overtime_hours),
      grossPay,
      overtimePay: money(row.overtime_pay),
      employees: count(row.employee_count),
      changePct:
        previousGrossPay > 0 ? round2(((grossPay - previousGrossPay) / previousGrossPay) * 100) : null,
    };
  });
}

async function readDataQuality(db: Db, jobId: string): Promise<PayrollMetrics['quality']> {
  const { rows: statusCounts } = await db.query(
    `SELECT status, COUNT(*) AS count FROM timesheet_rows WHERE job_id = $1 GROUP BY status`,
    [jobId],
  );
  const { rows: errorCounts } = await db.query(
    `SELECT error->>'code' AS code, COUNT(*) AS count
     FROM timesheet_rows, jsonb_array_elements(errors) AS error
     WHERE job_id = $1
     GROUP BY 1 ORDER BY 2 DESC`,
    [jobId],
  );

  const byStatus = Object.fromEntries(statusCounts.map((row) => [row.status, count(row.count)]));
  const validRows = byStatus.valid ?? 0;
  const invalidRows = byStatus.invalid ?? 0;
  const duplicateRows = byStatus.duplicate ?? 0;
  const totalRows = validRows + invalidRows + duplicateRows;

  return {
    totalRows,
    validRows,
    invalidRows,
    duplicateRows,
    validPct: percent(validRows, totalRows),
    errorBreakdown: errorCounts.map((row) => ({ code: row.code, count: count(row.count) })),
  };
}

function firstRow(result: { rows: any[] }): Record<string, any> {
  return result.rows[0] ?? {};
}

const asDate = (value: unknown): string | null => (value ? String(value).slice(0, 10) : null);
const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const money = (value: unknown): number => round2(Number(value) || 0);
const hours = (value: unknown): number => round2(Number(value) || 0);
const count = (value: unknown): number => Number(value) || 0;
const percent = (part: number, whole: number): number => (whole > 0 ? round2((part / whole) * 100) : 0);
