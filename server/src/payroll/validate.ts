import { parseClockTime, parseWorkDate, roundHours, isoWeek, todayIso, weekStart } from './time.js';
import type { TimesheetRow, UploadedRow, ValidationError } from './types.js';

const REQUIRED_FIELDS = [
  'employee_id',
  'employee_name',
  'department',
  'date',
  'clock_in',
  'clock_out',
  'hourly_rate',
] as const;

/**
 * Validates one uploaded row and derives the hours it worked.
 *
 * Only rules that can be decided from the row itself live here. Duplicates and
 * overlapping shifts need the employee's other rows, so they are applied later
 * in `resolveWorkday`.
 */
export function validateTimesheetRow(row: UploadedRow, today = todayIso()): TimesheetRow {
  const errors: ValidationError[] = [];

  const employeeCode = text(row.employee_id);
  const employeeName = text(row.employee_name);
  const department = text(row.department);
  const rawDate = text(row.date);
  const rawClockIn = text(row.clock_in);
  const rawClockOut = text(row.clock_out);
  const rawRate = text(row.hourly_rate);

  for (const field of REQUIRED_FIELDS) {
    if (text(row[field]) === '') {
      errors.push({ code: 'MISSING_FIELD', field, message: `${field} is required` });
    }
  }

  let workDate: string | null = null;
  if (rawDate !== '') {
    workDate = parseWorkDate(rawDate);
    if (!workDate) {
      errors.push({
        code: 'INVALID_DATE',
        field: 'date',
        message: `"${rawDate}" is not a valid date (expected YYYY-MM-DD)`,
      });
    } else if (workDate > today) {
      errors.push({ code: 'FUTURE_DATE', field: 'date', message: `date ${workDate} is in the future` });
    }
  }

  const clockInMinutes = rawClockIn === '' ? null : parseClockTime(rawClockIn);
  const clockOutMinutes = rawClockOut === '' ? null : parseClockTime(rawClockOut);

  if (rawClockIn !== '' && clockInMinutes === null) {
    errors.push({ code: 'INVALID_TIME', field: 'clock_in', message: `"${rawClockIn}" is not a valid time` });
  }
  if (rawClockOut !== '' && clockOutMinutes === null) {
    errors.push({ code: 'INVALID_TIME', field: 'clock_out', message: `"${rawClockOut}" is not a valid time` });
  }
  if (clockInMinutes !== null && clockOutMinutes !== null && clockOutMinutes <= clockInMinutes) {
    errors.push({
      code: 'CLOCK_OUT_NOT_AFTER_CLOCK_IN',
      field: 'clock_out',
      message: `clock_out (${rawClockOut}) must be after clock_in (${rawClockIn})`,
    });
  }

  let hourlyRate: number | null = null;
  if (rawRate !== '') {
    const rate = Number(rawRate.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(rate)) {
      errors.push({ code: 'INVALID_RATE', field: 'hourly_rate', message: `"${rawRate}" is not a number` });
    } else if (rate <= 0) {
      errors.push({
        code: 'NON_POSITIVE_RATE',
        field: 'hourly_rate',
        message: `hourly_rate must be greater than 0 (got ${rate})`,
      });
    } else {
      hourlyRate = Math.round(rate * 100) / 100;
    }
  }

  const isValid = errors.length === 0;
  const hoursWorked =
    isValid && clockInMinutes !== null && clockOutMinutes !== null
      ? roundHours((clockOutMinutes - clockInMinutes) / 60)
      : 0;

  return {
    rowNumber: row.rowNumber,
    employeeCode,
    employeeName,
    department: department || 'Unassigned',
    workDate,
    clockIn: rawClockIn || null,
    clockOut: rawClockOut || null,
    clockInMinutes,
    clockOutMinutes,
    hourlyRate,
    status: isValid ? 'valid' : 'invalid',
    errors,
    hoursWorked,
    regularHours: 0,
    overtimeHours: 0,
    regularPay: 0,
    overtimePay: 0,
    grossPay: 0,
    isoWeek: workDate ? isoWeek(workDate) : null,
    weekStart: workDate ? weekStart(workDate) : null,
    attempts: 1,
    raw: { ...row },
  };
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}
