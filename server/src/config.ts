import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

dotenv.config({ path: path.join(ROOT, '.env') });

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 4000),
  host: process.env.HOST ?? '0.0.0.0',

  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',

  /** Empty => embedded Postgres (PGlite). Set => real Postgres server. */
  databaseUrl: process.env.DATABASE_URL?.trim() || '',
  pgliteDir: process.env.PGLITE_DIR?.trim() || path.join(ROOT, '.data', 'pg'),

  /** Empty => in-process queue driver. Set => BullMQ + Redis. */
  redisUrl: process.env.REDIS_URL?.trim() || '',
  queueName: process.env.QUEUE_NAME ?? 'timesheet-jobs',
  /** When Redis is used, does this process also run the job worker? */
  inlineWorker: bool(process.env.INLINE_WORKER, true),

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
  logPretty: bool(process.env.LOG_PRETTY, process.env.NODE_ENV !== 'production'),
} as const;

export type OvertimeRules = {
  dailyThreshold: number;
  weeklyThreshold: number;
  multiplier: number;
};
