import { describe, expect, it } from 'vitest';
import { parseTimesheet } from '../src/payroll/parse.js';
import { validateTimesheetRow } from '../src/payroll/validate.js';
import {
  applyWeeklyOvertime,
  groupBy,
  payWeekKey,
  resolveWorkday,
  workdayKey,
} from '../src/payroll/calculate.js';
import type { OvertimeRules, TimesheetRow } from '../src/payroll/types.js';

const RULES: OvertimeRules = { dailyThreshold: 8, weeklyThreshold: 40, multiplier: 1.5 };
const HEADER = 'employee_id,employee_name,department,date,clock_in,clock_out,hourly_rate\n';

function pipeline(body: string, rules = RULES): TimesheetRow[] {
  const rows = parseTimesheet(HEADER + body).rows.map((r) => validateTimesheetRow(r, '2025-12-31'));
  for (const workday of groupBy(rows, workdayKey).values()) resolveWorkday(workday, rules);
  for (const week of groupBy(rows, payWeekKey).values()) applyWeeklyOvertime(week, rules);
  return rows;
}

describe('overlapping shifts', () => {
  it('keeps the earlier shift and rejects the overlapping one', () => {
    const rows = pipeline(
      `E1,A,Ops,2025-01-13,09:00,17:00,20\n` + `E1,A,Ops,2025-01-13,16:00,20:00,20\n`,
    );
    expect(rows[0].status).toBe('valid');
    expect(rows[1].status).toBe('invalid');
    expect(rows[1].errors.map((e) => e.code)).toContain('OVERLAPPING_SHIFT');
  });

  it('allows two non-overlapping shifts on the same day and splits them daily', () => {
    const rows = pipeline(
      `E1,A,Ops,2025-01-13,08:00,13:00,20\n` + `E1,A,Ops,2025-01-13,14:00,20:00,20\n`,
    );
    expect(rows.every((r) => r.status === 'valid')).toBe(true);
    // 5h + 6h = 11h -> 8 regular, 3 overtime, allocated in clock-in order
    expect(rows[0].regularHours).toBe(5);
    expect(rows[1].regularHours).toBe(3);
    expect(rows[1].overtimeHours).toBe(3);
    expect(rows[0].grossPay + rows[1].grossPay).toBe(8 * 20 + 3 * 20 * 1.5);
  });

  it('does not treat a different employee on the same day as an overlap', () => {
    const rows = pipeline(
      `E1,A,Ops,2025-01-13,09:00,17:00,20\n` + `E2,B,Ops,2025-01-13,09:00,17:00,20\n`,
    );
    expect(rows.every((r) => r.status === 'valid')).toBe(true);
  });
});

describe('duplicate detection', () => {
  it('keys on employee + date + clock_in', () => {
    const rows = pipeline(
      `E1,A,Ops,2025-01-13,09:00,17:00,20\n` +
        `E1,A,Ops,2025-01-13,09:00,18:00,20\n` + // same key -> duplicate
        `E1,A,Ops,2025-01-14,09:00,17:00,20\n`, // different day -> fine
    );
    expect(rows[0].status).toBe('valid');
    expect(rows[1].status).toBe('duplicate');
    expect(rows[2].status).toBe('valid');
  });

  it('is deterministic: the lowest row number is always the original', () => {
    const body = Array.from({ length: 5 }, () => `E1,A,Ops,2025-01-13,09:00,17:00,20\n`).join('');
    const rows = pipeline(body);
    expect(rows[0].status).toBe('valid');
    expect(rows.slice(1).every((r) => r.status === 'duplicate')).toBe(true);
  });
});

describe('weekly overtime threshold', () => {
  // Five 9-hour days in ISO week 2025-W03 (Mon 13th - Fri 17th).
  const week = ['13', '14', '15', '16', '17']
    .map((d) => `E1,A,Ops,2025-01-${d},09:00,18:00,20\n`)
    .join('');

  it('moves hours past 40 regular into overtime', () => {
    const rows = pipeline(week);
    const regular = rows.reduce((s, r) => s + r.regularHours, 0);
    const overtime = rows.reduce((s, r) => s + r.overtimeHours, 0);
    // 45h worked: daily rule already makes 5h overtime, leaving 40 regular.
    expect(regular).toBe(40);
    expect(overtime).toBe(5);
  });

  it('reclassifies from the latest shift first', () => {
    // Six 7-hour days: no daily overtime at all, but 42h in the week.
    const body = ['13', '14', '15', '16', '17', '18']
      .map((d) => `E1,A,Ops,2025-01-${d},09:00,16:00,20\n`)
      .join('');
    const rows = pipeline(body);
    expect(rows.reduce((s, r) => s + r.regularHours, 0)).toBe(40);
    expect(rows.reduce((s, r) => s + r.overtimeHours, 0)).toBe(2);
    expect(rows[5].overtimeHours).toBe(2); // the last day absorbed the excess
    expect(rows[0].overtimeHours).toBe(0);
  });

  it('does not leak overtime across week boundaries', () => {
    // 2025-01-17 is a Friday (W03); 2025-01-20 is the Monday of W04.
    const rows = pipeline(
      `E1,A,Ops,2025-01-17,09:00,18:00,20\n` + `E1,A,Ops,2025-01-20,09:00,18:00,20\n`,
    );
    expect(rows[0].isoWeek).toBe('2025-W03');
    expect(rows[1].isoWeek).toBe('2025-W04');
    expect(rows.every((r) => r.regularHours === 8 && r.overtimeHours === 1)).toBe(true);
  });
});

describe('configurable rules', () => {
  it('honours a 10h daily threshold and a 2x multiplier', () => {
    const rows = pipeline(`E1,A,Ops,2025-01-13,08:00,20:00,20\n`, {
      dailyThreshold: 10,
      weeklyThreshold: 40,
      multiplier: 2,
    });
    expect(rows[0].regularHours).toBe(10);
    expect(rows[0].overtimeHours).toBe(2);
    expect(rows[0].grossPay).toBe(10 * 20 + 2 * 20 * 2);
  });

  it('supports a weekly-only rule (daily threshold disabled)', () => {
    const rows = pipeline(
      ['13', '14', '15'].map((d) => `E1,A,Ops,2025-01-${d},08:00,20:00,20\n`).join(''),
      { dailyThreshold: 24, weeklyThreshold: 40, multiplier: 1.5 },
    );
    // 36h across three days, under the weekly threshold -> no overtime at all
    expect(rows.reduce((s, r) => s + r.overtimeHours, 0)).toBe(0);
    expect(rows.reduce((s, r) => s + r.regularHours, 0)).toBe(36);
  });
});

describe('pay precision', () => {
  it('prices a plain 8-hour shift', () => {
    const [row] = pipeline('E1,A,Ops,2025-01-13,09:00,17:00,23.75\n');
    expect(row.regularHours).toBe(8);
    expect(row.regularPay).toBe(190);
    expect(row.overtimePay).toBe(0);
    expect(row.grossPay).toBe(190);
  });

  it('prices a 12-hour shift as 8 regular + 4 overtime', () => {
    const [row] = pipeline('E1,A,Ops,2025-01-13,08:00,20:00,18.00\n');
    expect(row.regularPay).toBe(144);
    expect(row.overtimePay).toBe(108);
    expect(row.grossPay).toBe(252);
  });

  it('handles fractional hours to the cent', () => {
    // 08:15 -> 17:40 is 9.42h: 8 regular + 1.42 overtime at 21.37
    const [row] = pipeline('E1,A,Ops,2025-01-13,08:15,17:40,21.37\n');
    expect(row.hoursWorked).toBe(9.42);
    expect(row.regularPay).toBe(170.96);
    expect(row.overtimePay).toBe(45.52);
    expect(row.grossPay).toBe(216.48);
  });

  it('keeps gross pay equal to regular plus overtime on every row', () => {
    const rows = pipeline(
      ['13', '14', '15', '16', '17']
        .map((d) => `E1,A,Ops,2025-01-${d},09:00,18:37,33.33\n`)
        .join(''),
    );
    for (const row of rows) {
      expect(row.regularPay + row.overtimePay).toBe(row.grossPay);
    }
  });

  it('does not accumulate rounding drift across many small rows', () => {
    // Each row rounds to 0.02, but the exact total is 0.045 per three rows;
    // summing rounded lines is what payroll pays out, and must stay consistent.
    const rows = pipeline(
      ['13', '14', '15'].map((d) => `E1,A,Ops,2025-01-${d},09:00,09:01,60.00\n`).join(''),
    );
    const gross = rows.reduce((total, row) => total + row.grossPay, 0);
    const parts = rows.reduce((total, row) => total + row.regularPay + row.overtimePay, 0);
    expect(Math.round(gross * 100)).toBe(Math.round(parts * 100));
  });
});

describe('invalid rows never contribute to payroll', () => {
  it('zeroes hours and pay for rejected rows', () => {
    const rows = pipeline(
      `E1,A,Ops,2025-01-13,09:00,17:00,-5\n` + `E1,A,Ops,2025-01-14,10:00,09:00,20\n`,
    );
    expect(
      rows.every(
        (r) => r.grossPay === 0 && r.regularPay === 0 && r.overtimePay === 0 && r.regularHours === 0,
      ),
    ).toBe(true);
  });
});
