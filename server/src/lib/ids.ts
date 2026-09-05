import { randomUUID, randomBytes } from 'node:crypto';

export const uuid = (): string => randomUUID();

/** Short, human-quotable correlation id, e.g. "job_k3f9x2a1". */
export const correlationId = (prefix = 'job'): string =>
  `${prefix}_${randomBytes(5).toString('hex')}`;
