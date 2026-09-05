import { config } from '../config.js';
import { logger } from '../logger.js';

export type QueryResult<T> = { rows: T[]; rowCount: number };

export interface Db {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  /** Run `fn` inside a single transaction. */
  tx<T>(fn: (t: Db) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly driver: 'postgres' | 'pglite';
}

/* ------------------------------------------------------------------ *
 * Numeric handling
 * node-postgres returns NUMERIC/BIGINT as strings to avoid precision
 * loss. Payroll fits comfortably in a double, and having both drivers
 * agree keeps the application code free of `Number(x)` noise.
 * ------------------------------------------------------------------ */
const OID = { NUMERIC: 1700, INT8: 20, DATE: 1082 };

/* DATE columns are calendar days, not instants. Parsing them into a JS Date
 * attaches a local midnight, which then shifts a day when serialised to JSON
 * from a timezone east of UTC. Both drivers hand them back as 'YYYY-MM-DD'. */
const asIs = (v: string) => v;

async function createPostgres(): Promise<Db> {
  const pgMod = await import('pg');
  const pg = (pgMod as any).default ?? pgMod;
  pg.types.setTypeParser(OID.NUMERIC, (v: string) => (v === null ? null : parseFloat(v)));
  pg.types.setTypeParser(OID.INT8, (v: string) => (v === null ? null : parseInt(v, 10)));
  pg.types.setTypeParser(OID.DATE, asIs);

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err: Error) => logger.error({ err }, 'postgres pool error'));

  const wrap = (client: any): Db => ({
    driver: 'postgres',
    async query<T>(sql: string, params: any[] = []) {
      const r = await client.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
    async tx<T>(fn: (t: Db) => Promise<T>) {
      return fn(wrap(client)); // already inside a transaction
    },
    async close() {},
  });

  return {
    driver: 'postgres',
    async query<T>(sql: string, params: any[] = []) {
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async tx<T>(fn: (t: Db) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function createPglite(dir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir !== ':memory:') {
    // PGlite's own mkdir is not recursive, so create the parent tree first.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
  }
  const parsers = {
    [OID.NUMERIC]: (v: string) => parseFloat(v),
    [OID.INT8]: (v: string) => parseInt(v, 10),
    [OID.DATE]: asIs,
  } as any;

  const pg =
    dir === ':memory:'
      ? new PGlite({ parsers })
      : new PGlite(dir, { parsers });
  await pg.waitReady;

  const wrap = (h: any, driverTx: boolean): Db => ({
    driver: 'pglite',
    async query<T>(sql: string, params: any[] = []) {
      const r = await h.query(sql, params);
      return { rows: (r.rows ?? []) as T[], rowCount: r.affectedRows ?? r.rows?.length ?? 0 };
    },
    async exec(sql: string) {
      await h.exec(sql);
    },
    async tx<T>(fn: (t: Db) => Promise<T>) {
      if (driverTx) return h.transaction((t: any) => fn(wrap(t, false)));
      return fn(wrap(h, false));
    },
    async close() {
      if (driverTx) await h.close();
    },
  });

  return wrap(pg, true);
}

let instance: Db | null = null;

export async function getDb(): Promise<Db> {
  if (instance) return instance;
  if (config.databaseUrl) {
    logger.info({ driver: 'postgres' }, 'connecting to Postgres server');
    instance = await createPostgres();
  } else {
    logger.info({ driver: 'pglite', dir: config.pgliteDir }, 'starting embedded Postgres (PGlite)');
    instance = await createPglite(config.pgliteDir);
  }
  return instance;
}

/** Test helper: an isolated in-memory database. */
export async function createTestDb(): Promise<Db> {
  return createPglite(':memory:');
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}
