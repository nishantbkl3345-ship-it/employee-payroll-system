import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createTestDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrations/index.js';
import { runPayrollJob } from '../src/jobs/processor.js';

const SAMPLE = `employee_id,employee_name,department,date,clock_in,clock_out,hourly_rate
EMP-101,Sara Iyer,Engineering,2025-01-13,09:00,18:00,25.00
EMP-102,Karan Bhatt,Sales,2025-01-13,09:00,17:00,20.00
EMP-103,Neha Joshi,Engineering,2025-01-13,10:00,09:30,25.00
EMP-104,Vikram Das,Support,2025-01-13,08:00,20:00,18.00
EMP-101,Sara Iyer,Engineering,2025-01-13,09:00,18:00,25.00
EMP-105,Priya Nair,Sales,2025-01-13,09:00,17:00,-20.00
EMP-106,Arjun Rao,Support,2099-01-01,09:00,17:00,18.00
`;

const BOUNDARY = '----vitestboundary';
const multipart = (filename: string, content: string) =>
  [
    `--${BOUNDARY}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: text/csv',
    '',
    content,
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n');

let app: FastifyInstance;
let db: Db;

const signup = async (organizationName: string, email: string) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { organizationName, name: 'Owner', email, password: 'password123' },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { token: string; user: any; organization: any };
};

/** Uploads without auto-processing, then runs the pipeline inline (no delay). */
const uploadAndProcess = async (token: string, content = SAMPLE) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs/upload?autoProcess=false',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipart('timesheet.csv', content),
  });
  expect(res.statusCode).toBe(201);
  const jobId = res.json().job.id as string;
  await runPayrollJob({ db, jobId, rowDelayMs: 0, concurrency: 4 });
  return jobId;
};

beforeAll(async () => {
  db = await createTestDb();
  await migrate(db);
  ({ app } = await buildApp({ db, migrated: true }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('authentication', () => {
  it('signs up, logs in and returns the current user', async () => {
    const { token, user } = await signup('Acme Inc', 'owner@acme.test');
    expect(user.role).toBe('admin');

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@acme.test', password: 'password123' },
    });
    expect(login.statusCode).toBe(200);

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json().user.email).toBe('owner@acme.test');
  });

  it('rejects a wrong password and a missing token', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@acme.test', password: 'wrong-password' },
    });
    expect(bad.statusCode).toBe(401);

    const anon = await app.inject({ method: 'GET', url: '/api/jobs' });
    expect(anon.statusCode).toBe(401);
  });

  it('refuses a duplicate email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { organizationName: 'Other', name: 'X', email: 'owner@acme.test', password: 'password123' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('never returns the password hash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@acme.test', password: 'password123' },
    });
    expect(JSON.stringify(res.json())).not.toContain('password_hash');
  });
});

describe('upload and processing', () => {
  let token: string;
  let jobId: string;

  beforeAll(async () => {
    token = (await signup('Northwind', 'hr@northwind.test')).token;
    jobId = await uploadAndProcess(token);
  });

  it('completes the job and counts each row class', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const { job, metrics } = res.json();
    expect(job.status).toBe('completed');
    expect(job.total_rows).toBe(7);
    expect(metrics.quality).toMatchObject({ validRows: 3, invalidRows: 3, duplicateRows: 1 });
  });

  it('computes the expected payroll totals', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/metrics`,
      headers: { authorization: `Bearer ${token}` },
    });
    const { totals, byDepartment } = res.json().metrics;
    // Sara 237.50 + Karan 160.00 + Vikram 252.00
    expect(totals.grossPay).toBe(649.5);
    expect(totals.regularHours).toBe(24);
    expect(totals.overtimeHours).toBe(5);
    expect(totals.employees).toBe(3);
    expect(byDepartment.map((d: any) => d.department).sort()).toEqual([
      'Engineering',
      'Sales',
      'Support',
    ]);
  });

  it('exposes a sortable, searchable payroll table', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/payroll?sort=gross&dir=desc`,
      headers: { authorization: `Bearer ${token}` },
    });
    const rows = res.json().rows;
    expect(rows[0].employee_code).toBe('EMP-104'); // largest gross pay
    expect(rows.map((r: any) => r.gross_pay)).toEqual([252, 237.5, 160]);

    const search = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/payroll?q=karan`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(search.json().rows).toHaveLength(1);
  });

  it('lists invalid rows with their error codes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/rows?status=invalid`,
      headers: { authorization: `Bearer ${token}` },
    });
    const codes = res
      .json()
      .rows.flatMap((r: any) => (Array.isArray(r.errors) ? r.errors : JSON.parse(r.errors)))
      .map((e: any) => e.code);
    expect(codes).toContain('CLOCK_OUT_NOT_AFTER_CLOCK_IN');
    expect(codes).toContain('NON_POSITIVE_RATE');
    expect(codes).toContain('FUTURE_DATE');
  });

  it('exports an annotated CSV containing the flagged rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/export/annotated.csv`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain('DUPLICATE_ROW');
    expect(res.body.split('\r\n').filter(Boolean)).toHaveLength(8); // header + 7 rows
  });

  it('returns a day-by-day timesheet for one employee', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/employees/EMP-104/timesheet?jobId=${jobId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json();
    expect(body.summary.total_hours).toBe(12);
    expect(body.days).toHaveLength(1);
  });

  it('rejects an unparseable upload without creating a job', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/upload',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart('junk.csv', 'nothing,useful,here\n1,2,3\n'),
    });
    expect(res.statusCode).toBe(400);
    const after = await app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.json().total).toBe(before.json().total);
  });

  it('re-runs payroll after a rate correction', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${jobId}/employees/EMP-102/rate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { hourlyRate: 30 },
    });
    expect(res.statusCode).toBe(200);
    // Karan: 8h regular at 30 = 240 (was 160)
    expect(res.json().metrics.totals.grossPay).toBe(729.5);
  });

  it('records structured logs for the job', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/logs`,
      headers: { authorization: `Bearer ${token}` },
    });
    const events = res.json().logs.map((l: any) => l.event);
    expect(events).toContain('upload.received');
    expect(events).toContain('payroll_job.started');
    expect(events).toContain('payroll_job.completed');
    expect(res.json().correlationId).toMatch(/^job_/);
  });
});

describe('multi-tenancy and roles', () => {
  it('hides another organisation’s jobs', async () => {
    const a = await signup('Tenant A', 'a@tenant.test');
    const b = await signup('Tenant B', 'b@tenant.test');
    const jobId = await uploadAndProcess(a.token);

    const list = await app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(list.json().jobs).toHaveLength(0);

    const direct = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(direct.statusCode).toBe(404);
  });

  it('limits an employee account to its own payroll line', async () => {
    const admin = await signup('Roles Co', 'admin@roles.test');
    const jobId = await uploadAndProcess(admin.token);

    const created = await app.inject({
      method: 'POST',
      url: '/api/auth/users',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        name: 'Sara Iyer',
        email: 'sara@roles.test',
        password: 'password123',
        role: 'employee',
        employeeCode: 'EMP-101',
      },
    });
    expect(created.statusCode).toBe(201);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'sara@roles.test', password: 'password123' },
    });
    const employeeToken = login.json().token;

    const payroll = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/payroll`,
      headers: { authorization: `Bearer ${employeeToken}` },
    });
    expect(payroll.json().rows).toHaveLength(1);
    expect(payroll.json().rows[0].employee_code).toBe('EMP-101');

    const other = await app.inject({
      method: 'GET',
      url: `/api/employees/EMP-104/timesheet?jobId=${jobId}`,
      headers: { authorization: `Bearer ${employeeToken}` },
    });
    expect(other.statusCode).toBe(403);

    const upload = await app.inject({
      method: 'POST',
      url: '/api/jobs/upload',
      headers: {
        authorization: `Bearer ${employeeToken}`,
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipart('timesheet.csv', SAMPLE),
    });
    expect(upload.statusCode).toBe(403);

    // Every employee-scoped endpoint shares one authorisation check; assert each
    // route actually goes through it rather than only the first one.
    const otherPayslip = await app.inject({
      method: 'GET',
      url: `/api/employees/EMP-104/payslip.csv?jobId=${jobId}`,
      headers: { authorization: `Bearer ${employeeToken}` },
    });
    expect(otherPayslip.statusCode).toBe(403);

    const ownPayslip = await app.inject({
      method: 'GET',
      url: `/api/employees/EMP-101/payslip.csv?jobId=${jobId}`,
      headers: { authorization: `Bearer ${employeeToken}` },
    });
    expect(ownPayslip.statusCode).toBe(200);
    expect(ownPayslip.body).toContain('EMP-101');
    expect(ownPayslip.body).not.toContain('EMP-104');

    const logs = await app.inject({
      method: 'GET',
      url: '/api/logs',
      headers: { authorization: `Bearer ${employeeToken}` },
    });
    expect(logs.statusCode).toBe(403);

    const rows = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/export/annotated.csv`,
      headers: { authorization: `Bearer ${employeeToken}` },
    });
    expect(rows.body).not.toContain('EMP-104');
  });
});

describe('scale', () => {
  it('processes a 2,000 row file end to end', async () => {
    const { token } = await signup('Scale Co', 'scale@test.test');
    const header = 'employee_id,employee_name,department,date,clock_in,clock_out,hourly_rate\n';
    const days = ['2025-01-13', '2025-01-14', '2025-01-15', '2025-01-16'];
    // 500 employees x 4 distinct days — deliberately no duplicate keys.
    const body = Array.from({ length: 2000 }, (_, i) => {
      const emp = i % 500;
      const dayIdx = Math.floor(i / 500);
      return `EMP-${1000 + emp},Person ${emp},Dept${emp % 5},${days[dayIdx]},09:00,18:00,20.00`;
    }).join('\n');

    const jobId = await uploadAndProcess(token, header + body + '\n');
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/metrics`,
      headers: { authorization: `Bearer ${token}` },
    });
    const metrics = res.json().metrics;
    expect(metrics.quality.totalRows).toBe(2000);
    expect(metrics.quality.validRows).toBe(2000);
    expect(metrics.totals.employees).toBe(500);
    // 9h/day -> 8 regular + 1 overtime, 4 days each
    expect(metrics.totals.grossPay).toBe(500 * 4 * (8 * 20 + 1 * 20 * 1.5));
  });
});
