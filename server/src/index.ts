import { buildApp } from './app.js';
import { config } from './config.js';
import { getQueue, closeQueue } from './jobs/queue.js';
import { bus } from './lib/bus.js';
import { closeDb } from './db/index.js';
import { logger } from './logger.js';
import { attachWebSockets } from './ws/index.js';

async function main(): Promise<void> {
  await bus.connect();
  const { app, db } = await buildApp();

  const queue = getQueue(db);
  if (!config.redisUrl || config.inlineWorker) {
    await queue.startWorker();
  }

  await app.listen({ port: config.port, host: config.host });
  const ws = attachWebSockets(app.server);

  logger.info(
    {
      port: config.port,
      db: db.driver,
      queue: queue.driver,
      workerConcurrency: config.workerConcurrency,
      rowDelayMs: config.rowProcessingDelayMs,
    },
    'payroll API ready',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await ws.close();
      await app.close();
      await closeQueue();
      await bus.close();
      await closeDb();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start server');
  process.exit(1);
});
