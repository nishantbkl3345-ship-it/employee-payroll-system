import type { ErrorCode, ProcessedRow, RawRow, RowError } from './types.js';
import { isoWeek, parseDate, parseTimeToMinutes, round2, todayISO, weekStart } from './time.js';

export interface ValidationOptions {
  /** Reference "today"; rows dated after this are rejected. Injectable for tests. */
  today?: string;
  /** Optional guard: shifts longer than this (hours) are rejected. Disabled when undefined. */
  maxShiftHours?: number;
}

const REQUIRED: Array<[keyof RawRow & string, string]> = [
  ['employee_id', 'employee_id'],
  ['employee_name', 'employee_name'],
  ['department', 'department'],
  ['date', 'date'],
  ['clock_in', 'clock_in'],
  ['clock_out', 'clock_out'],
  ['hourly_rate', 'hourly_rate'],
];

const err = (code: ErrorCode, message: string, field?: string): RowError => ({ code, message, field });

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Field-level validation + per-shift hours for a single row.
 *
 * Cross-row rules (duplicates, overlapping shifts) and the regular/overtime
 * split are deliberately *not* handled here: they are set-based and are applied
 * in `resolveDay` / `applyWeeklyOvertime` once rows are grouped.
 */
export function validateRow(raw: RawRow, opts: ValidationOptions = {}): ProcessedRow {
  const today = opts.today ?? todayISO();
  const errors: RowError[] = [];

  const employeeCode = str(raw.employee_id);
  const employeeName = str(raw.employee_name);
  const department = str(raw.department);
  const dateStr = str(raw.date);
  const inStr = str(raw.clock_in);
  const outStr = str(raw.clock_out);
  const rateStr = str(raw.hourly_rate);

  for (const [key, label] of REQUIRED) {
    if (str(raw[key]) === '') errors.push(err('MISSING_FIELD', `${label} is required`, label));
  }

  // ---- date ----
  let workDate: string | null = null;
  if (dateStr !== '') {
    workDate = parseDate(dateStr);
    if (!workDate) {
      errors.push(err('INVALID_DATE', `"${dateStr}" is not a valid calendar date`, 'date'));
    } else if (workDate > today) {
      errors.push(err('FUTURE_DATE', `date ${workDate} is in the future`, 'date'));
    }
  }

  // ---- times ----
  let minutesIn: number | null = null;
  let minutesOut: number | null = null;
  if (inStr !== '') {
    minutesIn = parseTimeToMinutes(inStr);
    if (minutesIn === null) errors.push(err('INVALID_TIME', `"${inStr}" is not a valid time`, 'clock_in'));
  }
  if (outStr !== '') {
    minutesOut = parseTimeToMinutes(outStr);
    if (minutesOut === null) errors.push(err('INVALID_TIME', `"${outStr}" is not a valid time`, 'clock_out'));
  }
  if (minutesIn !== null && minutesOut !== null && minutesOut <= minutesIn) {
    errors.push(
      err(
        'CLOCK_OUT_NOT_AFTER_CLOCK_IN',
        `clock_out (${outStr}) must be after clock_in (${inStr}) on the same shift`,
        'clock_out',
      ),
    );
  }

  // ---- rate ----
  let hourlyRate: number | null = null;
  if (rateStr !== '') {
    const cleaned = rateStr.replace(/[$,\s]/g, '');
    const n = Number(cleaned);
    if (!Number.isFinite(n)) {
      errors.push(err('INVALID_RATE', `"${rateStr}" is not a number`, 'hourly_rate'));
    } else if (n <= 0) {
      errors.push(err('NON_POSITIVE_RATE', `hourly_rate must be greater than 0 (got ${n})`, 'hourly_rate'));
    } else {
      hourlyRate = round2(n);
    }
  }

  // ---- derived hours ----
  let hoursWorked = 0;
  if (minutesIn !== null && minutesOut !== null && minutesOut > minutesIn) {
    hoursWorked = round2((minutesOut - minutesIn) / 60);
    if (opts.maxShiftHours !== undefined && hoursWorked > opts.maxShiftHours) {
      errors.push(
        err(
          'IMPLAUSIBLE_SHIFT_LENGTH',
          `shift of ${hoursWorked}h exceeds the configured maximum of ${opts.maxShiftHours}h`,
          'clock_out',
        ),
      );
    }
  }

  return {
    rowNumber: raw.rowNumber,
    employeeCode,
    employeeName,
    department: department || 'Unassigned',
    workDate,
    clockIn: inStr || null,
    clockOut: outStr || null,
    minutesIn,
    minutesOut,
    hourlyRate,
    status: errors.length ? 'invalid' : 'valid',
    errors,
    hoursWorked: errors.length ? 0 : hoursWorked,
    regularHours: 0,
    overtimeHours: 0,
    grossPay: 0,
    isoWeek: workDate ? isoWeek(workDate) : null,
    weekStart: workDate ? weekStart(workDate) : null,
    attempts: 1,
    processingMs: 0,
    raw: { ...raw },
  };
}

export const dayKey = (r: ProcessedRow): string => `${r.employeeCode}|${r.workDate ?? '-'}`;
export const dupKey = (r: ProcessedRow): string =>
  `${r.employeeCode}|${r.workDate ?? '-'}|${r.clockIn ?? '-'}`;
export const weekKey = (r: ProcessedRow): string => `${r.employeeCode}|${r.isoWeek ?? '-'}`;
