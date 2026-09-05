import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { getDb, type Db } from './db/index.js';
import { migrate } from './db/migrations/index.js';
import { logger } from './logger.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerEmployeeRoutes } from './routes/employees.js';
import { registerReportRoutes } from './routes/reports.js';

export interface BuildAppOptions {
  db?: Db;
  /** Skip migrations when the caller has already prepared the schema. */
  migrated?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<{ app: FastifyInstance; db: Db }> {
  const db = options.db ?? (await getDb());
  if (!options.migrated) await migrate(db);

  const app = Fastify({
    // pino's concrete Logger narrows Fastify's generics, which then makes the
    // instance incompatible with plain FastifyInstance in the route modules.
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: config.maxUploadMb * 1024 * 1024,
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
  });

  await app.register(cors, {
    // Auth is a bearer token, not a cookie, so credentialed CORS is unnecessary.
    origin: config.corsOrigins.length ? config.corsOrigins : true,
    exposedHeaders: ['content-disposition'],
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  });
  await app.register(rateLimit, { global: false, max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((error: FastifyError, req, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err: error, reqId: req.id }, 'unhandled request error');
      return reply.code(500).send({
        error: 'internal_error',
        message: 'Something went wrong on our side',
        requestId: req.id,
      });
    }
    req.log.warn({ reqId: req.id, status, err: error.message }, 'request rejected');
    return reply.code(status).send({
      error: error.code ?? 'request_error',
      message: error.message,
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

  await serveWebApp(app);
  return { app, db };
}

/** In a container the API also serves the built SPA; in development Vite does. */
async function serveWebApp(app: FastifyInstance): Promise<void> {
  const webDist = process.env.WEB_DIST ?? path.join(ROOT, 'web', 'dist');
  if (process.env.SERVE_WEB === 'false' || !existsSync(path.join(webDist, 'index.html'))) return;

  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, { root: webDist, wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws') || req.url.startsWith('/healthz')) {
      return reply.code(404).send({ error: 'not_found', message: `No route for ${req.method} ${req.url}` });
    }
    return reply.sendFile('index.html');
  });
  logger.info({ webDist }, 'serving the built web app');
}
