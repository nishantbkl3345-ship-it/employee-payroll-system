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

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 10);

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, BCRYPT_ROUNDS);
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

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const q = (req.query as any)?.token;
  return typeof q === 'string' && q ? q : null;
}

/** Attaches `req.auth` when a valid token is present. Returns the user or null. */
function authenticate(req: FastifyRequest): AuthUser | null {
  const token = extractToken(req);
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

/** Sentinel that matches no employee: an employee-role user with no linked record. */
export const NO_EMPLOYEE = '__no_employee__';

/**
 * Employees are restricted to their own records. Returns the employee_code the
 * caller is limited to, or null when unrestricted.
 */
export function scopeEmployeeCode(user: AuthUser): string | null {
  return canSeeEveryone(user) ? null : (user.employeeCode ?? NO_EMPLOYEE);
}
