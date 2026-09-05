import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Page {
  limit: number;
  offset: number;
}

export function pageFrom(query: Record<string, string | undefined>, defaultLimit = 50): Page {
  const limit = clamp(Number(query.limit), defaultLimit, 1, 500);
  const offset = clamp(Number(query.offset), 0, 0, 1_000_000);
  return { limit, offset };
}

export function clamp(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

export interface PayrollJobRef {
  id: string;
  org_id: string;
  correlation_id: string;
  status: string;
}

/**
 * Loads the job named in the route, scoped to the caller's organisation, and
 * replies 404 when it belongs to someone else. Returning null (rather than
 * throwing) keeps the handlers' happy path flat.
 */
export async function requireJob(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<PayrollJobRef | null> {
  const jobId = (req.params as { id: string }).id;
  if (!UUID.test(jobId)) {
    await reply.code(404).send({ error: 'not_found', message: 'Job not found' });
    return null;
  }

  const { rows } = await db.query<PayrollJobRef>(
    'SELECT id, org_id, correlation_id, status FROM jobs WHERE id = $1 AND org_id = $2',
    [jobId, req.auth!.orgId],
  );
  if (!rows[0]) {
    await reply.code(404).send({ error: 'not_found', message: 'Job not found' });
    return null;
  }
  return rows[0];
}

export const isUuid = (value: string | undefined): boolean => !!value && UUID.test(value);
