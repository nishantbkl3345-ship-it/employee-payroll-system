import { assertProductionConfig, config } from './config.js';
import { buildApp } from './app.js';
import { closeDb } from './db/index.js';
import { getPayrollQueue, shutdownQueue } from './jobs/queue.js';
import { jobEvents } from './jobs/progress.js';
import { logger } from './logger.js';
import { attachWebSockets } from './ws/index.js';

async function main(): Promise<void> {
  assertProductionConfig();
  await jobEvents.connect();

  const { app, db } = await buildApp();
  const queue = getPayrollQueue(db);
  if (!config.redisUrl || config.inlineWorker) await queue.startWorker();

  await app.listen({ port: config.port, host: config.host });
  const websockets = attachWebSockets(app.server);

  logger.info(
    {
      port: config.port,
      db: db.driver,
      queue: queue.driver,
      workerConcurrency: config.workerConcurrency,
    },
    'payroll API ready',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await websockets.close();
      // Drains in-flight payroll jobs before the database connection closes.
      await shutdownQueue();
      await jobEvents.close();
      await closeDb();
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.fatal({ err: error }, 'failed to start the API');
  process.exit(1);
});
