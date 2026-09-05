import type { Db } from '../index.js';
import { logger } from '../../logger.js';
import * as m001 from './001_init.js';

const migrations = [m001];

export async function migrate(db: Db): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);

  for (const migration of migrations) {
    const { rows } = await db.query<{ id: string }>('SELECT id FROM _migrations WHERE id = $1', [
      migration.id,
    ]);
    if (rows.length) continue;
    logger.info({ migration: migration.id }, 'applying migration');
    await db.exec(migration.sql);
    await db.query('INSERT INTO _migrations (id) VALUES ($1)', [migration.id]);
  }
}
