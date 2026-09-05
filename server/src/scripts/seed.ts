/**
 * Seeds a demo organisation, three users (admin / HR / employee) and one fully
 * processed payroll job so the dashboard has something to show on first run.
 *
 *   npm run seed
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { hashPassword } from '../auth/index.js';
import { config, ROOT } from '../config.js';
import { closeDb, getDb } from '../db/index.js';
import { migrate } from '../db/migrations/index.js';
import { processJob } from '../jobs/processor.js';
import { correlationId } from '../lib/ids.js';
import { logger } from '../logger.js';
import { generate } from './generate-sample.js';

const DEMO = {
  org: 'Northwind Labs',
  admin: { email: 'admin@demo.io', password: 'password123', name: 'Alex Admin' },
  hr: { email: 'hr@demo.io', password: 'password123', name: 'Harper HR' },
  employee: { email: 'employee@demo.io', password: 'password123', name: 'Sara Iyer' },
};

async function main(): Promise<void> {
  const db = await getDb();
  await migrate(db);

  const existing = await db.query<{ id: string }>('SELECT id FROM organizations WHERE slug = $1', [
    'northwind-labs',
  ]);
  if (existing.rows.length) {
    logger.info('demo organisation already exists — nothing to seed');
    await closeDb();
    return;
  }

  const { rows: orgRows } = await db.query<{ id: string }>(
    `INSERT INTO organizations (name, slug, ot_daily_threshold, ot_weekly_threshold, ot_multiplier)
     VALUES ($1, 'northwind-labs', $2, $3, $4) RETURNING id`,
    [DEMO.org, config.overtime.dailyThreshold, config.overtime.weeklyThreshold, config.overtime.multiplier],
  );
  const orgId = orgRows[0].id;

  const { rows: adminRows } = await db.query<{ id: string }>(
    `INSERT INTO users (org_id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'admin') RETURNING id`,
    [orgId, DEMO.admin.email, DEMO.admin.name, await hashPassword(DEMO.admin.password)],
  );
  await db.query(
    `INSERT INTO users (org_id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'hr')`,
    [orgId, DEMO.hr.email, DEMO.hr.name, await hashPassword(DEMO.hr.password)],
  );

  // Two payroll runs: the brief's sample file, then a realistic two-week file.
  const samplePath = path.join(ROOT, 'samples', 'timesheet_sample.csv');
  const specSample = existsSync(samplePath)
    ? readFileSync(samplePath, 'utf8')
    : 'employee_id,employee_name,department,date,clock_in,clock_out,hourly_rate\n';

  const files: Array<{ name: string; content: string }> = [
    { name: 'timesheet_sample.csv', content: specSample },
    { name: 'timesheet_two_weeks.csv', content: generate(600) },
  ];

  let firstEmployeeCode = 'EMP-0101';
  for (const file of files) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO jobs (org_id, uploaded_by, correlation_id, filename, status, stage)
       VALUES ($1, $2, $3, $4, 'pending', 'uploaded') RETURNING id`,
      [orgId, adminRows[0].id, correlationId(), file.name],
    );
    await db.query('INSERT INTO job_files (job_id, content) VALUES ($1, $2)', [rows[0].id, file.content]);
    logger.info({ file: file.name }, 'processing seed job');
    await processJob({ db, jobId: rows[0].id, rowDelayMs: 0 });
  }

  const { rows: empRows } = await db.query<{ employee_code: string }>(
    'SELECT employee_code FROM employees WHERE org_id = $1 ORDER BY employee_code ASC LIMIT 1',
    [orgId],
  );
  firstEmployeeCode = empRows[0]?.employee_code ?? firstEmployeeCode;

  await db.query(
    `INSERT INTO users (org_id, email, name, password_hash, role, employee_code)
     VALUES ($1, $2, $3, $4, 'employee', $5)`,
    [orgId, DEMO.employee.email, DEMO.employee.name, await hashPassword(DEMO.employee.password), firstEmployeeCode],
  );

  logger.info(
    {
      organization: DEMO.org,
      admin: `${DEMO.admin.email} / ${DEMO.admin.password}`,
      hr: `${DEMO.hr.email} / ${DEMO.hr.password}`,
      employee: `${DEMO.employee.email} / ${DEMO.employee.password} (linked to ${firstEmployeeCode})`,
    },
    'seed complete',
  );
  await closeDb();
}

main().catch((err) => {
  logger.fatal({ err }, 'seed failed');
  process.exit(1);
});
