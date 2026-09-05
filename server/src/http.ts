import type { FastifyInstance } from 'fastify';

/**
 * The concrete Fastify instance this app builds.
 *
 * We hand Fastify a pre-built pino logger, which narrows the instance's Logger
 * generic; route modules should not have to care, so they accept this alias
 * rather than the default-generic `FastifyInstance`.
 */
export type App = FastifyInstance<any, any, any, any, any>;
