import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, one, all, insert, update } from './db.js';
import { stamp } from './time.js';
import { audit, clientIp } from './audit.js';
import { getSetting } from './settings.js';

export const COOKIE_NAME = 'cdh_session';

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

const USER_SQL = `
  SELECT u.id, u.username, u.full_name, u.email, u.active, u.department_id,
         u.must_change_password, u.last_login_at, u.role_id,
         r.code AS role_code, r.name AS role_name, r.department_scope,
         d.code AS department_code, d.name AS department_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN departments d ON d.id = u.department_id`;

export function findUserByUsername(username) {
  return one(`${USER_SQL} WHERE lower(u.username) = lower(@username)`, { username });
}

export function getUserById(id) {
  return one(`${USER_SQL} WHERE u.id = @id`, { id });
}

export function permissionsOf(roleId) {
  return all(
    `SELECT p.code FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = @roleId`, { roleId },
  ).map((r) => r.code);
}

/** Adjunta permisos al objeto de usuario. */
export function withPermissions(user) {
  if (!user) return null;
  return { ...user, permissions: permissionsOf(user.role_id) };
}

export function createSession(user, req) {
  const t = stamp();
  const token = crypto.randomBytes(32).toString('hex');
  const hours = Number(getSetting('session_hours', 12)) || 12;
  insert('sessions', {
    id: crypto.randomUUID(),
    user_id: user.id,
    token_hash: hashToken(token),
    ip: clientIp(req),
    user_agent: req?.headers?.['user-agent']?.slice(0, 400) ?? null,
    created_at: t.iso,
    expires_at: new Date(t.epoch + hours * 3600_000).toISOString(),
  });
  update('users', user.id, { last_login_at: t.iso });
  return { token, expiresAt: new Date(t.epoch + hours * 3600_000) };
}

export function resolveSession(token) {
  if (!token) return null;
  const row = one(
    `SELECT * FROM sessions WHERE token_hash = @h AND revoked_at IS NULL`,
    { h: hashToken(token) },
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  const user = getUserById(row.user_id);
  if (!user || !user.active) return null;
  return { session: row, user: withPermissions(user) };
}

export function revokeSession(token) {
  if (!token) return;
  db.prepare(`UPDATE sessions SET revoked_at = @now WHERE token_hash = @h AND revoked_at IS NULL`)
    .run({ now: new Date().toISOString(), h: hashToken(token) });
}

export function revokeAllSessions(userId, reason, actor, req) {
  const changes = db.prepare(
    `UPDATE sessions SET revoked_at = @now WHERE user_id = @u AND revoked_at IS NULL`,
  ).run({ now: new Date().toISOString(), u: userId }).changes;
  if (changes) {
    audit({
      entityType: 'session', entityId: userId, action: 'revoke_all', actor,
      after: { revoked: changes }, reason, req,
    });
  }
  return changes;
}

export function purgeExpiredSessions() {
  return db.prepare(`DELETE FROM sessions WHERE expires_at < @now`)
    .run({ now: new Date(Date.now() - 7 * 86400000).toISOString() }).changes;
}
