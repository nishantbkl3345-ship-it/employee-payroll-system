import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrations/index.js';
import { newCorrelationId } from '../src/jobs/events.js';
import { runPayrollJob } from '../src/jobs/processor.js';
import type { PayrollMetrics } from '../src/payroll/aggregate.js';

const HEADER = 'employee_id,employee_name,department,date,clock_in,clock_out,hourly_rate\n';

/**
 * Two ISO weeks of hand-computable data:
 *   W02 (Jan 6-10)  Ana  Engineering  9h/day x 2 @ 40.00
 *   W02             Ben  Support      8h/day x 2 @ 20.00
 *   W03 (Jan 13-17) Ana  Engineering  8h/day x 2 @ 40.00
 *   W03             Cara Support     12h/day x 1 @ 20.00
 */
const TIMESHEET =
  HEADER +
  [
    'E-1,Ana,Engineering,2025-01-06,09:00,18:00,40.00',
    'E-1,Ana,Engineering,2025-01-07,09:00,18:00,40.00',
    'E-2,Ben,Support,2025-01-06,09:00,17:00,20.00',
    'E-2,Ben,Support,2025-01-07,09:00,17:00,20.00',
    'E-1,Ana,Engineering,2025-01-13,09:00,17:00,40.00',
    'E-1,Ana,Engineering,2025-01-14,09:00,17:00,40.00',
    'E-3,Cara,Support,2025-01-13,08:00,20:00,20.00',
  ].join('\n') +
  '\n';

let db: Db;
let metrics: PayrollMetrics;

async function processTimesheet(csv: string): Promise<PayrollMetrics> {
  const { rows: orgs } = await db.query<{ id: string }>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Org ${Math.random()}`, `org-${Math.random().toString(36).slice(2)}`],
  );
  const { rows: jobs } = await db.query<{ id: string }>(
    `INSERT INTO jobs (org_id, correlation_id, filename, status, stage)
     VALUES ($1, $2, 'timesheet.csv', 'pending', 'uploaded') RETURNING id`,
    [orgs[0].id, newCorrelationId()],
  );
  await db.query('INSERT INTO job_files (job_id, content) VALUES ($1, $2)', [jobs[0].id, csv]);

  const result = await runPayrollJob({ db, jobId: jobs[0].id, rowDelayMs: 0, concurrency: 4 });
  return result.metrics;
}

beforeAll(async () => {
  db = await createTestDb();
  await migrate(db);
  metrics = await processTimesheet(TIMESHEET);
});

afterAll(async () => {
  await db.close();
});

describe('company totals', () => {
  it('sums gross pay across every employee', () => {
    // Ana W02: 2 x (8x40 + 1x40x1.5) = 760; Ana W03: 2 x 8x40 = 640
    // Ben: 2 x 8x20 = 320; Cara: 8x20 + 4x20x1.5 = 280
    expect(metrics.totals.grossPay).toBe(2000);
    expect(metrics.totals.regularPay).toBe(1760);
    expect(metrics.totals.overtimePay).toBe(240);
  });

  it('splits regular and overtime hours', () => {
    expect(metrics.totals.regularHours).toBe(56);
    expect(metrics.totals.overtimeHours).toBe(6);
    expect(metrics.totals.totalHours).toBe(62);
  });

  it('counts distinct employees and days worked', () => {
    expect(metrics.totals.employees).toBe(3);
    expect(metrics.totals.daysWorked).toBe(7);
  });

  it('averages hours per employee', () => {
    expect(metrics.totals.avgHoursPerEmployee).toBeCloseTo(62 / 3, 2);
  });

  it('reports overtime as a share of payroll and of hours', () => {
    expect(metrics.totals.overtimePctOfPayroll).toBe(12); // 240 / 2000
    expect(metrics.totals.overtimeHoursPct).toBeCloseTo(9.68, 2); // 6 / 62
  });

  it('keeps gross equal to regular plus overtime', () => {
    expect(metrics.totals.regularPay + metrics.totals.overtimePay).toBe(metrics.totals.grossPay);
  });
});

describe('department totals', () => {
  const departmentNamed = (name: string) => metrics.byDepartment.find((d) => d.department === name)!;

  it('groups payroll by department, largest first', () => {
    expect(metrics.byDepartment.map((d) => d.department)).toEqual(['Engineering', 'Support']);
  });

  it('totals each department independently', () => {
    expect(departmentNamed('Engineering')).toMatchObject({
      employees: 1,
      regularHours: 32,
      overtimeHours: 2,
      grossPay: 1400,
    });
    expect(departmentNamed('Support')).toMatchObject({
      employees: 2,
      regularHours: 24,
      overtimeHours: 4,
      grossPay: 600,
    });
  });

  it('reports each department’s overtime percentage', () => {
    expect(departmentNamed('Support').overtimePct).toBe(20); // 120 / 600
  });
});

describe('weekly trend', () => {
  it('produces one entry per ISO week, oldest first', () => {
    expect(metrics.weekly.map((w) => w.isoWeek)).toEqual(['2025-W02', '2025-W03']);
    expect(metrics.weekly[0].weekStart).toBe('2025-01-06');
  });

  it('totals payroll per week', () => {
    expect(metrics.weekly[0].grossPay).toBe(1080); // Ana 760 + Ben 320
    expect(metrics.weekly[1].grossPay).toBe(920); // Ana 640 + Cara 280
  });

  it('reports week-over-week change, with none for the first week', () => {
    expect(metrics.weekly[0].changePct).toBeNull();
    expect(metrics.weekly[1].changePct).toBeCloseTo(-14.81, 2);
  });
});

describe('top overtime', () => {
  it('ranks employees by overtime hours', () => {
    expect(metrics.topOvertime.map((e) => e.employeeCode)).toEqual(['E-3', 'E-1']);
    expect(metrics.topOvertime[0]).toMatchObject({ overtimeHours: 4, overtimePay: 120 });
  });

  it('excludes employees with no overtime', () => {
    expect(metrics.topOvertime.some((e) => e.employeeCode === 'E-2')).toBe(false);
  });
});

describe('standard deviation of hours', () => {
  it('is zero when every shift is the same length', async () => {
    const identical =
      HEADER +
      ['06', '07', '08'].map((d) => `E-9,Same,Ops,2025-01-${d},09:00,17:00,20.00`).join('\n') +
      '\n';
    const flat = await processTimesheet(identical);
    expect(flat.totals.stddevShiftHours).toBe(0);
  });

  it('measures the spread of shift lengths', async () => {
    // 4h, 8h, 12h -> sample stddev = 4
    const varied =
      HEADER +
      [
        'E-9,Varied,Ops,2025-01-06,09:00,13:00,20.00',
        'E-9,Varied,Ops,2025-01-07,09:00,17:00,20.00',
        'E-9,Varied,Ops,2025-01-08,08:00,20:00,20.00',
      ].join('\n') +
      '\n';
    const spread = await processTimesheet(varied);
    expect(spread.totals.stddevShiftHours).toBe(4);
    expect(spread.irregularSchedules[0]).toMatchObject({ employeeCode: 'E-9', shifts: 3 });
  });
});

describe('data quality', () => {
  it('counts rows by verdict and breaks errors down by rule', async () => {
    const messy =
      HEADER +
      [
        'E-1,Ana,Ops,2025-01-06,09:00,17:00,20.00',
        'E-1,Ana,Ops,2025-01-06,09:00,17:00,20.00', // duplicate
        'E-2,Ben,Ops,2025-01-06,17:00,09:00,20.00', // reversed
        'E-3,Cara,Ops,2025-01-06,09:00,17:00,-5.00', // negative rate
      ].join('\n') +
      '\n';
    const quality = (await processTimesheet(messy)).quality;

    expect(quality).toMatchObject({ totalRows: 4, validRows: 1, invalidRows: 2, duplicateRows: 1 });
    expect(quality.validPct).toBe(25);
    expect(Object.fromEntries(quality.errorBreakdown.map((e) => [e.code, e.count]))).toEqual({
      DUPLICATE_ROW: 1,
      CLOCK_OUT_NOT_AFTER_CLOCK_IN: 1,
      NON_POSITIVE_RATE: 1,
    });
  });
});

describe('re-running aggregation', () => {
  it('is idempotent — the same rows produce the same totals', async () => {
    const first = await processTimesheet(TIMESHEET);
    const second = await processTimesheet(TIMESHEET);
    expect(second.totals).toEqual(first.totals);
    expect(second.byDepartment).toEqual(first.byDepartment);
  });
});
