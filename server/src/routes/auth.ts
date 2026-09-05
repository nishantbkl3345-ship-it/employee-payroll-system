import type { App } from '../http.js';
import { z } from 'zod';
import {
  hashPassword,
  requireAuth,
  requireRole,
  signToken,
  verifyPassword,
  type AuthUser,
  type Role,
} from '../auth/index.js';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { recordEvent } from '../lib/eventlog.js';

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'org';

const signupSchema = z.object({
  organizationName: z.string().min(2).max(120),
  name: z.string().min(1).max(120),
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

const inviteSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  role: z.enum(['admin', 'hr', 'employee']),
  employeeCode: z.string().max(60).optional().nullable(),
});

const rulesSchema = z.object({
  dailyThreshold: z.number().min(0).max(24),
  weeklyThreshold: z.number().min(0).max(168),
  multiplier: z.number().min(1).max(5),
});

interface UserRow {
  id: string;
  org_id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  employee_code: string | null;
}

const toAuthUser = (row: UserRow): AuthUser => ({
  id: row.id,
  orgId: row.org_id,
  email: row.email,
  name: row.name,
  role: row.role,
  employeeCode: row.employee_code,
});

export function registerAuthRoutes(app: App, db: Db): void {
  app.post('/api/auth/signup', async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.flatten() });
    }
    const { organizationName, name, password } = parsed.data;
    const email = parsed.data.email.toLowerCase();

    const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      return reply.code(409).send({ error: 'email_taken', message: 'That email is already registered' });
    }

    // Unique-ish slug without a round trip per attempt.
    const base = slugify(organizationName);
    const { rows: clash } = await db.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM organizations WHERE slug = $1 OR slug LIKE $2',
      [base, `${base}-%`],
    );
    const slug = clash[0].n > 0 ? `${base}-${clash[0].n + 1}` : base;

    const result = await db.tx(async (tx) => {
      const { rows: orgRows } = await tx.query<{ id: string }>(
        `INSERT INTO organizations (name, slug, ot_daily_threshold, ot_weekly_threshold, ot_multiplier)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          organizationName,
          slug,
          config.overtime.dailyThreshold,
          config.overtime.weeklyThreshold,
          config.overtime.multiplier,
        ],
      );
      const orgId = orgRows[0].id;
      const { rows: userRows } = await tx.query<UserRow>(
        `INSERT INTO users (org_id, email, name, password_hash, role)
         VALUES ($1, $2, $3, $4, 'admin')
         RETURNING id, org_id, email, name, password_hash, role, employee_code`,
        [orgId, email, name, await hashPassword(password)],
      );
      return { user: userRows[0], orgId, slug };
    });

    const user = toAuthUser(result.user);
    await recordEvent(db, {
      orgId: user.orgId,
      event: 'auth.signup',
      message: `New organisation "${organizationName}" created by ${email}`,
      data: { userId: user.id, slug: result.slug },
    });

    return reply.code(201).send({
      token: signToken(user),
      user,
      organization: { id: result.orgId, name: organizationName, slug: result.slug },
    });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.flatten() });
    }
    const email = parsed.data.email.toLowerCase();

    const { rows } = await db.query<UserRow>(
      `SELECT id, org_id, email, name, password_hash, role, employee_code
       FROM users WHERE email = $1`,
      [email],
    );
    const row = rows[0];
    const ok = row ? await verifyPassword(parsed.data.password, row.password_hash) : false;
    if (!row || !ok) {
      req.log.warn({ email, event: 'auth.login_failed' }, 'failed login attempt');
      return reply.code(401).send({ error: 'invalid_credentials', message: 'Email or password is incorrect' });
    }

    const user = toAuthUser(row);
    const { rows: orgRows } = await db.query(
      'SELECT id, name, slug, ot_daily_threshold, ot_weekly_threshold, ot_multiplier FROM organizations WHERE id = $1',
      [user.orgId],
    );
    return reply.send({ token: signToken(user), user, organization: orgRows[0] });
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.auth!;
    const { rows } = await db.query(
      'SELECT id, name, slug, ot_daily_threshold, ot_weekly_threshold, ot_multiplier FROM organizations WHERE id = $1',
      [user.orgId],
    );
    return reply.send({ user, organization: rows[0] ?? null });
  });

  // ---- team management (admin only) ----
  app.get('/api/auth/users', { preHandler: requireRole('admin', 'hr') }, async (req, reply) => {
    const { rows } = await db.query(
      `SELECT id, email, name, role, employee_code, created_at
       FROM users WHERE org_id = $1 ORDER BY created_at ASC`,
      [req.auth!.orgId],
    );
    return reply.send({ users: rows });
  });

  app.post('/api/auth/users', { preHandler: requireRole('admin') }, async (req, reply) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.flatten() });
    }
    const email = parsed.data.email.toLowerCase();
    const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      return reply.code(409).send({ error: 'email_taken', message: 'That email is already registered' });
    }

    const { rows } = await db.query<UserRow>(
      `INSERT INTO users (org_id, email, name, password_hash, role, employee_code)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, org_id, email, name, password_hash, role, employee_code`,
      [
        req.auth!.orgId,
        email,
        parsed.data.name,
        await hashPassword(parsed.data.password),
        parsed.data.role,
        parsed.data.employeeCode || null,
      ],
    );
    await recordEvent(db, {
      orgId: req.auth!.orgId,
      event: 'auth.user_created',
      message: `${req.auth!.email} created ${parsed.data.role} account ${email}`,
      data: { createdUserId: rows[0].id },
    });
    return reply.code(201).send({ user: toAuthUser(rows[0]) });
  });

  // ---- configurable overtime rules for the organisation ----
  app.put('/api/organization/rules', { preHandler: requireRole('admin') }, async (req, reply) => {
    const parsed = rulesSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.flatten() });
    }
    const { dailyThreshold, weeklyThreshold, multiplier } = parsed.data;
    const { rows } = await db.query(
      `UPDATE organizations
       SET ot_daily_threshold = $2, ot_weekly_threshold = $3, ot_multiplier = $4
       WHERE id = $1
       RETURNING id, name, slug, ot_daily_threshold, ot_weekly_threshold, ot_multiplier`,
      [req.auth!.orgId, dailyThreshold, weeklyThreshold, multiplier],
    );
    await recordEvent(db, {
      orgId: req.auth!.orgId,
      event: 'organization.rules_updated',
      message: `Overtime rules updated by ${req.auth!.email}`,
      data: parsed.data,
    });
    return reply.send({ organization: rows[0] });
  });
}
