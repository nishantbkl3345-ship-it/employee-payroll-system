import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

dotenv.config({ path: path.join(ROOT, '.env') });

const DEV_JWT_SECRET = 'dev-secret-change-me';

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const environment = process.env.NODE_ENV ?? 'development';

export const config = {
  env: environment,
  isProduction: environment === 'production',
  port: num(process.env.PORT, 4000),
  host: process.env.HOST ?? '0.0.0.0',

  jwtSecret: process.env.JWT_SECRET?.trim() || DEV_JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  bcryptRounds: num(process.env.BCRYPT_ROUNDS, 10),
  /** Empty means "reflect any origin", which is only allowed outside production. */
  corsOrigins: list(process.env.CORS_ORIGINS),

  /** Empty selects the embedded Postgres (PGlite); set it to use a Postgres server. */
  databaseUrl: process.env.DATABASE_URL?.trim() || '',
  pgliteDir: process.env.PGLITE_DIR?.trim() || path.join(ROOT, '.data', 'pg'),
  pgPoolMax: num(process.env.PG_POOL_MAX, 10),

  /** Empty selects the in-process queue; set it to use BullMQ + Redis. */
  redisUrl: process.env.REDIS_URL?.trim() || '',
  queueName: process.env.QUEUE_NAME ?? 'payroll-jobs',
  /** With Redis configured, does the API process also consume jobs? */
  inlineWorker: bool(process.env.INLINE_WORKER, true),
  maxParallelJobs: num(process.env.MAX_PARALLEL_JOBS, 2),

  workerConcurrency: num(process.env.WORKER_CONCURRENCY, 8),
  rowProcessingDelayMs: num(process.env.ROW_PROCESSING_DELAY_MS, 4),
  rowMaxAttempts: num(process.env.ROW_MAX_ATTEMPTS, 3),
  maxUploadMb: num(process.env.MAX_UPLOAD_MB, 25),
  uploadRateLimitPerMin: num(process.env.UPLOAD_RATE_LIMIT_PER_MIN, 10),

  overtime: {
    dailyThreshold: num(process.env.OT_DAILY_THRESHOLD, 8),
    weeklyThreshold: num(process.env.OT_WEEKLY_THRESHOLD, 40),
    multiplier: num(process.env.OT_MULTIPLIER, 1.5),
  },

  logLevel: process.env.LOG_LEVEL ?? 'info',
  logPretty: bool(process.env.LOG_PRETTY, environment !== 'production'),
} as const;

/**
 * Refuses to boot a production process with development defaults. A shipped
 * JWT secret means anyone can mint a token for any organisation.
 */
export function assertProductionConfig(): void {
  if (!config.isProduction) return;

  const problems: string[] = [];
  if (config.jwtSecret === DEV_JWT_SECRET) problems.push('JWT_SECRET is still the development default');
  if (config.jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
  if (!config.corsOrigins.length) problems.push('CORS_ORIGINS must list the allowed browser origins');

  if (problems.length) {
    throw new Error(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
  }
}
