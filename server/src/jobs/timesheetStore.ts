import type { Db } from '../db/index.js';
import type { TimesheetRow } from '../payroll/types.js';

/** Rows per multi-value INSERT. 250 x 20 columns stays well inside Postgres' parameter limit. */
const INSERT_BATCH_SIZE = 250;

const ROW_COLUMNS = [
  'job_id',
  'org_id',
  'row_number',
  'employee_code',
  'employee_name',
  'department',
  'work_date',
  'clock_in',
  'clock_out',
  'hourly_rate',
  'status',
  'errors',
  'hours_worked',
  'regular_hours',
  'overtime_hours',
  'regular_pay',
  'overtime_pay',
  'gross_pay',
  'iso_week',
  'week_start',
  'attempts',
  'raw',
] as const;

const JSONB_COLUMNS = new Set(['errors', 'raw']);

export async function replaceTimesheetRows(
  db: Db,
  jobId: string,
  organizationId: string,
  rows: TimesheetRow[],
  onProgress: (written: number, total: number) => void,
): Promise<void> {
  await db.query('DELETE FROM timesheet_rows WHERE job_id = $1', [jobId]);

  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      values.push(
        jobId,
        organizationId,
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
        row.regularPay,
        row.overtimePay,
        row.grossPay,
        row.isoWeek,
        row.weekStart,
        row.attempts,
        JSON.stringify(row.raw),
      );
      return placeholders(values.length - ROW_COLUMNS.length);
    });

    await db.query(
      `INSERT INTO timesheet_rows (${ROW_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`,
      values,
    );
    onProgress(Math.min(offset + batch.length, rows.length), rows.length);
  }
}

/**
 * Keeps the employee directory in step with the file in one statement — a
 * per-employee upsert loop cost a round trip per employee (1,000+ on a large
 * file) for what is a single insert.
 */
export async function syncEmployeeDirectory(
  db: Db,
  organizationId: string,
  rows: TimesheetRow[],
): Promise<void> {
  const employees = new Map<string, TimesheetRow>();
  for (const row of rows) {
    if (row.status === 'valid' && row.employeeCode) employees.set(row.employeeCode, row);
  }
  if (!employees.size) return;

  const values: unknown[] = [];
  const tuples = [...employees.values()].map((row, index) => {
    values.push(organizationId, row.employeeCode, row.employeeName, row.department);
    return `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`;
  });

  await db.query(
    `INSERT INTO employees (org_id, employee_code, name, department)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (org_id, employee_code)
     DO UPDATE SET name = EXCLUDED.name, department = EXCLUDED.department`,
    values,
  );
}

function placeholders(startIndex: number): string {
  const parts = ROW_COLUMNS.map((column, i) => {
    const position = `$${startIndex + i + 1}`;
    return JSONB_COLUMNS.has(column) ? `${position}::jsonb` : position;
  });
  return `(${parts.join(', ')})`;
}
