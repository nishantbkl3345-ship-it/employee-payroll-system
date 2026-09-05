import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

export type Role = 'admin' | 'hr' | 'employee';

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  employeeCode: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthUser;
  }
}

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, config.bcryptRounds);
export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

export function signToken(user: AuthUser): string {
  return jwt.sign(
    {
      sub: user.id,
      org: user.orgId,
      email: user.email,
      name: user.name,
      role: user.role,
      emp: user.employeeCode,
    },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn as any },
  );
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as any;
    return {
      id: payload.sub,
      orgId: payload.org,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      employeeCode: payload.emp ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Header only. Tokens in query strings leak into access logs, proxy logs and
 * browser history; the WebSocket handshake reads its own `?token=` because
 * browsers cannot set headers there.
 */
function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** Attaches `req.auth` when a valid token is present. Returns the user or null. */
function authenticate(req: FastifyRequest): AuthUser | null {
  const token = bearerToken(req);
  const user = token ? verifyToken(token) : null;
  if (user) req.auth = user;
  return user;
}

/** preHandler: rejects the request unless a valid token is present. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!authenticate(req)) {
    return reply.code(401).send({ error: 'unauthorized', message: 'A valid access token is required' });
  }
}

/** preHandler factory: requires one of the given roles (implies requireAuth). */
export function requireRole(...roles: Role[]) {
  return async function roleGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = req.auth ?? authenticate(req);
    if (!user) {
      return reply.code(401).send({ error: 'unauthorized', message: 'A valid access token is required' });
    }
    if (!roles.includes(user.role)) {
      return reply.code(403).send({
        error: 'forbidden',
        message: `This action requires the ${roles.join(' or ')} role`,
      });
    }
  };
}

/** True when the user may see data for every employee in the organisation. */
export const canSeeEveryone = (user: AuthUser): boolean => user.role === 'admin' || user.role === 'hr';

/** Matches no employee, for an employee-role account with no linked record. */
const NO_EMPLOYEE = '__no_employee__';

/**
 * Returns the employee_code the caller is limited to, or null when they may see
 * the whole organisation. Callers add it to the WHERE clause, so the filter is
 * applied by the database rather than after the fact.
 */
export function restrictToOwnEmployeeCode(user: AuthUser): string | null {
  return canSeeEveryone(user) ? null : (user.employeeCode ?? NO_EMPLOYEE);
}
