/**
 * Standalone queue worker, used with REDIS_URL so heavy payroll runs do not
 * compete with API request handling. Without Redis the API runs jobs itself and
 * this process has nothing to consume.
 */
import { assertProductionConfig, config } from './config.js';
import { closeDb, getDb } from './db/index.js';
import { migrate } from './db/migrations/index.js';
import { jobEvents } from './jobs/progress.js';
import { getPayrollQueue, shutdownQueue } from './jobs/queue.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  assertProductionConfig();
  if (!config.redisUrl) {
    logger.warn('REDIS_URL is not set — the API process runs jobs in-process and this worker will idle');
  }

  await jobEvents.connect();
  const db = await getDb();
  await migrate(db);

  const queue = getPayrollQueue(db);
  await queue.startWorker();
  logger.info({ queue: queue.driver, concurrency: config.workerConcurrency }, 'payroll worker ready');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    await shutdownQueue();
    await jobEvents.close();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
