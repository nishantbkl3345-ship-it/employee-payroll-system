/**
 * Standalone queue worker.
 *
 * Only useful with REDIS_URL set (BullMQ): it consumes timesheet jobs from the
 * shared queue so heavy payroll runs never compete with API request handling.
 * With the in-process queue driver the API process runs jobs itself.
 */
import { config } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { migrate } from './db/migrations/index.js';
import { getQueue, closeQueue } from './jobs/queue.js';
import { bus } from './lib/bus.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  if (!config.redisUrl) {
    logger.warn('REDIS_URL is not set — the API process handles jobs in-process; this worker has nothing to do');
  }
  await bus.connect();
  const db = await getDb();
  await migrate(db);

  const queue = getQueue(db);
  await queue.startWorker();
  logger.info({ queue: queue.driver, concurrency: config.workerConcurrency }, 'payroll worker ready');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    await closeQueue();
    await bus.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
