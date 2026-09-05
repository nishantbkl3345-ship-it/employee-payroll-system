import { roundHours } from './time.js';
import type { OvertimeRules, RowStatus, TimesheetRow, ValidationError } from './types.js';

/**
 * Payroll calculation.
 *
 *   hours worked -> regular + overtime hours -> regular + overtime pay -> gross pay
 *
 * Pay is computed in whole cents. Rounding each earning line once and summing
 * integers keeps a payslip's regular + overtime equal to its gross, which
 * summing rounded floats does not guarantee.
 */

/** Earnings for a block of hours, in whole cents. */
export function payCents(hours: number, hourlyRate: number, multiplier = 1): number {
  return Math.round(hours * Math.round(hourlyRate * 100) * multiplier);
}

export const fromCents = (cents: number): number => cents / 100;

export const workdayKey = (row: TimesheetRow): string => `${row.employeeCode}|${row.workDate ?? '-'}`;
export const payWeekKey = (row: TimesheetRow): string => `${row.employeeCode}|${row.isoWeek ?? '-'}`;

/**
 * Applies the rules that need an employee's whole workday: duplicate rows,
 * overlapping shifts, and the daily overtime threshold.
 *
 * Rows are ordered by row number rather than by whichever worker finished
 * first, so a re-run of the same file always flags the same rows.
 */
export function resolveWorkday(workday: TimesheetRow[], rules: OvertimeRules): TimesheetRow[] {
  const rows = [...workday].sort(byRowNumber);

  const seenShifts = new Set<string>();
  for (const row of rows) {
    const shift = `${row.workDate ?? '-'}|${row.clockIn ?? '-'}`;
    if (seenShifts.has(shift)) {
      reject(row, 'duplicate', {
        code: 'DUPLICATE_ROW',
        message: `duplicate of an earlier row for ${row.employeeCode} on ${row.workDate} at ${row.clockIn}`,
      });
    } else if (row.status === 'valid') {
      seenShifts.add(shift);
    }
  }

  const shifts = rows
    .filter((row) => row.status === 'valid' && row.clockInMinutes !== null)
    .sort((a, b) => a.clockInMinutes! - b.clockInMinutes! || a.rowNumber - b.rowNumber);

  const accepted: TimesheetRow[] = [];
  for (const row of shifts) {
    const clash = accepted.find(
      (other) => row.clockInMinutes! < other.clockOutMinutes! && other.clockInMinutes! < row.clockOutMinutes!,
    );
    if (clash) {
      reject(row, 'invalid', {
        code: 'OVERLAPPING_SHIFT',
        message: `shift ${row.clockIn}-${row.clockOut} overlaps row ${clash.rowNumber} (${clash.clockIn}-${clash.clockOut}) on ${row.workDate}`,
      });
      continue;
    }
    accepted.push(row);
  }

  let regularHoursLeft = Math.max(0, rules.dailyThreshold);
  for (const row of accepted) {
    const regularHours = Math.min(row.hoursWorked, regularHoursLeft);
    row.regularHours = roundHours(regularHours);
    row.overtimeHours = roundHours(row.hoursWorked - regularHours);
    regularHoursLeft -= regularHours;
  }

  return rows;
}

/**
 * Applies the weekly overtime threshold to one employee's ISO week and prices
 * the result. Hours past the threshold are moved to overtime starting from the
 * most recent shift — the hours that actually crossed the line.
 */
export function applyWeeklyOvertime(payWeek: TimesheetRow[], rules: OvertimeRules): TimesheetRow[] {
  const worked = payWeek.filter((row) => row.status === 'valid').sort(byShiftOrder);
  const totalRegularHours = worked.reduce((total, row) => total + row.regularHours, 0);

  let excessHours = roundHours(Math.max(0, totalRegularHours - Math.max(0, rules.weeklyThreshold)));
  for (let i = worked.length - 1; i >= 0 && excessHours > 0; i--) {
    const row = worked[i];
    const moved = Math.min(row.regularHours, excessHours);
    if (moved <= 0) continue;
    row.regularHours = roundHours(row.regularHours - moved);
    row.overtimeHours = roundHours(row.overtimeHours + moved);
    excessHours = roundHours(excessHours - moved);
  }

  for (const row of payWeek) {
    if (row.status !== 'valid') {
      row.regularHours = 0;
      row.overtimeHours = 0;
      row.regularPay = 0;
      row.overtimePay = 0;
      row.grossPay = 0;
      continue;
    }
    const regularCents = payCents(row.regularHours, row.hourlyRate!);
    const overtimeCents = payCents(row.overtimeHours, row.hourlyRate!, rules.multiplier);

    row.regularPay = fromCents(regularCents);
    row.overtimePay = fromCents(overtimeCents);
    // Divided once from the integer total: adding the two currency values back
    // together would reintroduce the float error this avoids.
    row.grossPay = fromCents(regularCents + overtimeCents);
  }

  return payWeek;
}

export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

function reject(row: TimesheetRow, status: RowStatus, error: ValidationError) {
  row.status = status;
  row.errors = [...row.errors, error];
  row.hoursWorked = 0;
  row.regularHours = 0;
  row.overtimeHours = 0;
}

const byRowNumber = (a: TimesheetRow, b: TimesheetRow) => a.rowNumber - b.rowNumber;

const byShiftOrder = (a: TimesheetRow, b: TimesheetRow) =>
  (a.workDate ?? '').localeCompare(b.workDate ?? '') ||
  (a.clockInMinutes ?? 0) - (b.clockInMinutes ?? 0) ||
  a.rowNumber - b.rowNumber;
