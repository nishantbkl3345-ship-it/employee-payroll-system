import type { OvertimeRules, ProcessedRow } from './types.js';
import { round2 } from './time.js';
import { dupKey } from './validate.js';

/**
 * Cross-row rules for a single (employee, date) group:
 *   1. duplicates  - identical employee + date + clock_in; first occurrence wins
 *   2. overlaps    - a shift that overlaps an already-accepted shift that day
 *   3. daily split - hours beyond the daily threshold become overtime
 *
 * Deterministic: rows are ordered by row_number / clock_in, never by the order
 * the worker pool happened to finish them in.
 */
export function resolveDay(group: ProcessedRow[], rules: OvertimeRules): ProcessedRow[] {
  const rows = [...group].sort((a, b) => a.rowNumber - b.rowNumber);

  const seen = new Set<string>();
  for (const row of rows) {
    const key = dupKey(row);
    if (seen.has(key)) {
      row.status = 'duplicate';
      row.errors = [
        ...row.errors,
        {
          code: 'DUPLICATE_ROW',
          message: `duplicate of an earlier row for ${row.employeeCode} on ${row.workDate} at ${row.clockIn}`,
        },
      ];
      row.hoursWorked = 0;
      continue;
    }
    // Only rows that are otherwise usable establish the "original".
    if (row.status === 'valid') seen.add(key);
  }

  const candidates = rows
    .filter((r) => r.status === 'valid' && r.minutesIn !== null && r.minutesOut !== null)
    .sort((a, b) => a.minutesIn! - b.minutesIn! || a.rowNumber - b.rowNumber);

  const accepted: ProcessedRow[] = [];
  for (const row of candidates) {
    const clash = accepted.find((a) => row.minutesIn! < a.minutesOut! && a.minutesIn! < row.minutesOut!);
    if (clash) {
      row.status = 'invalid';
      row.errors = [
        ...row.errors,
        {
          code: 'OVERLAPPING_SHIFT',
          message: `shift ${row.clockIn}-${row.clockOut} overlaps row ${clash.rowNumber} (${clash.clockIn}-${clash.clockOut}) on ${row.workDate}`,
        },
      ];
      row.hoursWorked = 0;
      continue;
    }
    accepted.push(row);
  }

  // Daily regular/overtime split, filled in clock-in order across the day.
  let remaining = Math.max(0, rules.dailyThreshold);
  for (const row of accepted) {
    const regular = Math.min(row.hoursWorked, remaining);
    row.regularHours = round2(regular);
    row.overtimeHours = round2(row.hoursWorked - regular);
    remaining = Math.max(0, remaining - regular);
  }

  return rows;
}

/**
 * Weekly overtime rule for one (employee, ISO week) group: once weekly regular
 * hours pass the threshold, the excess is reclassified as overtime starting
 * from the most recent shift (the hours that actually crossed the line).
 * Finally, gross pay is computed from the settled split.
 */
export function applyWeeklyOvertime(group: ProcessedRow[], rules: OvertimeRules): ProcessedRow[] {
  const valid = group
    .filter((r) => r.status === 'valid')
    .sort(
      (a, b) =>
        (a.workDate ?? '').localeCompare(b.workDate ?? '') ||
        (a.minutesIn ?? 0) - (b.minutesIn ?? 0) ||
        a.rowNumber - b.rowNumber,
    );

  const threshold = Number.isFinite(rules.weeklyThreshold) ? Math.max(0, rules.weeklyThreshold) : Infinity;
  const totalRegular = round2(valid.reduce((s, r) => s + r.regularHours, 0));

  let excess = round2(Math.max(0, totalRegular - threshold));
  for (let i = valid.length - 1; i >= 0 && excess > 0; i--) {
    const row = valid[i];
    const move = Math.min(row.regularHours, excess);
    if (move <= 0) continue;
    row.regularHours = round2(row.regularHours - move);
    row.overtimeHours = round2(row.overtimeHours + move);
    excess = round2(excess - move);
  }

  for (const row of group) {
    row.grossPay = row.status === 'valid' ? grossPay(row, rules) : 0;
    if (row.status !== 'valid') {
      row.regularHours = 0;
      row.overtimeHours = 0;
    }
  }
  return group;
}

export function grossPay(row: ProcessedRow, rules: OvertimeRules): number {
  const rate = row.hourlyRate ?? 0;
  return round2(row.regularHours * rate + row.overtimeHours * rate * rules.multiplier);
}

export const regularPay = (row: ProcessedRow): number => round2(row.regularHours * (row.hourlyRate ?? 0));
export const overtimePay = (row: ProcessedRow, rules: OvertimeRules): number =>
  round2(row.overtimeHours * (row.hourlyRate ?? 0) * rules.multiplier);

export function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}
