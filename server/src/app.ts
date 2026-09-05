import Fastify from 'fastify';
import type { App } from './http.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { config, ROOT } from './config.js';
import { getDb, type Db } from './db/index.js';
import { migrate } from './db/migrations/index.js';
import { logger } from './logger.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerEmployeeRoutes } from './routes/employees.js';
import { registerReportRoutes } from './routes/reports.js';

export interface BuildOptions {
  db?: Db;
  /** Skip migrations when the caller has already prepared the schema. */
  migrated?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: App; db: Db }> {
  const db = opts.db ?? (await getDb());
  if (!opts.migrated) await migrate(db);

  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    bodyLimit: config.maxUploadMb * 1024 * 1024,
    // Every request carries an id; job routes additionally carry a correlation id.
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    exposedHeaders: ['content-disposition'],
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  });
  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });

  app.setErrorHandler((error: any, req: any, reply: any) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err: error, reqId: req.id }, 'unhandled request error');
    } else {
      req.log.warn({ err: error.message, reqId: req.id, status }, 'request rejected');
    }
    reply.code(status).send({
      error: status >= 500 ? 'internal_error' : (error.code ?? 'request_error'),
      message: status >= 500 ? 'Something went wrong on our side' : error.message,
      requestId: req.id,
    });
  });

  app.get('/healthz', async () => ({
    ok: true,
    db: db.driver,
    queue: config.redisUrl ? 'bullmq' : 'memory',
    uptimeSec: Math.round(process.uptime()),
  }));

  registerAuthRoutes(app, db);
  registerJobRoutes(app, db);
  registerEmployeeRoutes(app, db);
  registerReportRoutes(app, db);

  // In a container the API also serves the built single-page app, so the whole
  // product is one process. In development Vite serves it and proxies here.
  const webDist = process.env.WEB_DIST ?? path.join(ROOT, 'web', 'dist');
  if (process.env.SERVE_WEB !== 'false' && existsSync(path.join(webDist, 'index.html'))) {
    const staticPlugin = (await import('@fastify/static')).default;
    await app.register(staticPlugin, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req: any, reply: any) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws') || req.url.startsWith('/healthz')) {
        return reply.code(404).send({ error: 'not_found', message: `No route for ${req.method} ${req.url}` });
      }
      return reply.sendFile('index.html');
    });
    logger.info({ webDist }, 'serving the built web app');
  }

  return { app, db };
}
