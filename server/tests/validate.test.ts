import { describe, expect, it } from 'vitest';
import { parseUpload } from '../src/payroll/parse.js';
import { validateRow, dayKey, weekKey } from '../src/payroll/validate.js';
import { applyWeeklyOvertime, groupBy, resolveDay } from '../src/payroll/compute.js';
import type { OvertimeRules, ProcessedRow } from '../src/payroll/types.js';

const RULES: OvertimeRules = { dailyThreshold: 8, weeklyThreshold: 40, multiplier: 1.5 };

/** The exact sample from the brief. */
const SAMPLE = `employee_id,employee_name,department,date,clock_in,clock_out,hourly_rate
EMP-101,Sara Iyer,Engineering,2025-01-13,09:00,18:00,25.00
EMP-102,Karan Bhatt,Sales,2025-01-13,09:00,17:00,20.00
EMP-103,Neha Joshi,Engineering,2025-01-13,10:00,09:30,25.00
EMP-104,Vikram Das,Support,2025-01-13,08:00,20:00,18.00
EMP-101,Sara Iyer,Engineering,2025-01-13,09:00,18:00,25.00
EMP-105,Priya Nair,Sales,2025-01-13,09:00,17:00,-20.00
EMP-106,Arjun Rao,Support,2099-01-01,09:00,17:00,18.00
`;

/** Runs the same three phases the worker pool runs, but sequentially. */
function pipeline(csv: string, rules = RULES, today = '2025-06-01'): ProcessedRow[] {
  const parsed = parseUpload(csv);
  const rows = parsed.rows.map((r) => validateRow(r, { today }));
  for (const group of groupBy(rows, dayKey).values()) resolveDay(group, rules);
  for (const group of groupBy(rows, weekKey).values()) applyWeeklyOvertime(group, rules);
  return rows;
}

describe('the brief sample file', () => {
  const rows = pipeline(SAMPLE);
  const byRow = (n: number) => rows.find((r) => r.rowNumber === n)!;

  it('parses every data row', () => {
    expect(rows).toHaveLength(7);
  });

  it('accepts a normal 9h shift and splits it 8 regular / 1 overtime', () => {
    const sara = byRow(2);
    expect(sara.status).toBe('valid');
    expect(sara.hoursWorked).toBe(9);
    expect(sara.regularHours).toBe(8);
    expect(sara.overtimeHours).toBe(1);
    // 8 * 25 + 1 * 25 * 1.5
    expect(sara.grossPay).toBe(237.5);
  });

  it('accepts an 8h shift with no overtime', () => {
    const karan = byRow(3);
    expect(karan.status).toBe('valid');
    expect(karan.overtimeHours).toBe(0);
    expect(karan.grossPay).toBe(160);
  });

  it('rejects clock_out before clock_in', () => {
    const neha = byRow(4);
    expect(neha.status).toBe('invalid');
    expect(neha.errors.map((e) => e.code)).toContain('CLOCK_OUT_NOT_AFTER_CLOCK_IN');
    expect(neha.grossPay).toBe(0);
  });

  it("splits EMP-104's 12h shift into 8 regular + 4 overtime", () => {
    const vikram = byRow(5);
    expect(vikram.status).toBe('valid');
    expect(vikram.hoursWorked).toBe(12);
    expect(vikram.regularHours).toBe(8);
    expect(vikram.overtimeHours).toBe(4);
    // 8 * 18 + 4 * 18 * 1.5
    expect(vikram.grossPay).toBe(252);
  });

  it('flags the repeated row as a duplicate and keeps the original', () => {
    expect(byRow(6).status).toBe('duplicate');
    expect(byRow(6).errors.map((e) => e.code)).toContain('DUPLICATE_ROW');
    expect(byRow(2).status).toBe('valid');
  });

  it('rejects a negative hourly rate', () => {
    const priya = byRow(7);
    expect(priya.status).toBe('invalid');
    expect(priya.errors.map((e) => e.code)).toContain('NON_POSITIVE_RATE');
  });

  it('rejects a future date', () => {
    const arjun = byRow(8);
    expect(arjun.status).toBe('invalid');
    expect(arjun.errors.map((e) => e.code)).toContain('FUTURE_DATE');
  });

  it('never throws: the whole file still produces a verdict per row', () => {
    expect(rows.filter((r) => r.status === 'valid')).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'invalid')).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'duplicate')).toHaveLength(1);
  });
});

describe('field validation', () => {
  const row = (over: Partial<Record<string, string>>) =>
    validateRow(
      {
        rowNumber: 2,
        employee_id: 'E1',
        employee_name: 'Test',
        department: 'Ops',
        date: '2025-01-13',
        clock_in: '09:00',
        clock_out: '17:00',
        hourly_rate: '20',
        ...over,
      } as any,
      { today: '2025-06-01' },
    );

  it('requires every mandatory field', () => {
    const r = row({ employee_id: '', department: '' });
    const missing = r.errors.filter((e) => e.code === 'MISSING_FIELD').map((e) => e.field);
    expect(missing).toEqual(['employee_id', 'department']);
  });

  it('rejects impossible calendar dates', () => {
    expect(row({ date: '2025-02-30' }).errors.map((e) => e.code)).toContain('INVALID_DATE');
  });

  it('rejects malformed times', () => {
    expect(row({ clock_in: '25:00' }).errors.map((e) => e.code)).toContain('INVALID_TIME');
  });

  it('rejects a zero rate as well as a negative one', () => {
    expect(row({ hourly_rate: '0' }).errors.map((e) => e.code)).toContain('NON_POSITIVE_RATE');
    expect(row({ hourly_rate: 'abc' }).errors.map((e) => e.code)).toContain('INVALID_RATE');
  });

  it('rejects equal clock in/out (a zero-length shift)', () => {
    expect(row({ clock_out: '09:00' }).errors.map((e) => e.code)).toContain(
      'CLOCK_OUT_NOT_AFTER_CLOCK_IN',
    );
  });

  it('computes fractional hours to two decimals', () => {
    expect(row({ clock_in: '09:15', clock_out: '17:40' }).hoursWorked).toBe(8.42);
  });
});
