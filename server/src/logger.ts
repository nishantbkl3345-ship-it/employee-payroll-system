import pino from 'pino';
import { config } from './config.js';

/**
 * Structured JSON logging by default (production-friendly, machine parseable).
 * In development we pipe through pino-pretty for humans.
 *
 * Every job carries a correlation_id; child loggers bind it so a single job can
 * be traced across the API process, the queue and the worker pool.
 */
export const logger = pino(
  {
    level: config.logLevel,
    base: { service: 'payroll-api', env: config.env },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: ['req.headers.authorization', 'password', '*.password', 'password_hash', '*.password_hash'],
      censor: '[redacted]',
    },
  },
  config.logPretty
    ? pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
      })
    : undefined,
);
