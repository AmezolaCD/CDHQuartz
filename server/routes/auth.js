import express from 'express';
import {
  COOKIE_NAME, findUserByUsername, verifyPassword, createSession,
  revokeSession, withPermissions, hashPassword, getUserById,
} from '../lib/auth.js';
import { update, one } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { requireAuth, asyncRoute } from '../middleware/auth.js';
import { getSetting } from '../lib/settings.js';

const router = express.Router();

const publicUser = (u) => ({
  id: u.id, username: u.username, fullName: u.full_name, email: u.email,
  role: { id: u.role_id, code: u.role_code, name: u.role_name },
  department: u.department_id ? { id: u.department_id, code: u.department_code, name: u.department_name } : null,
  departmentScope: !!u.department_scope,
  mustChangePassword: !!u.must_change_password,
  lastLoginAt: u.last_login_at,
  permissions: u.permissions ?? [],
});

router.post('/login', asyncRoute((req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son obligatorios.' });
  }
  const found = findUserByUsername(String(username).trim());
  const row = found ? one('SELECT password_hash FROM users WHERE id = @id', { id: found.id }) : null;

  if (!found || !row || !verifyPassword(String(password), row.password_hash)) {
    audit({
      entityType: 'auth', entityId: found?.id ?? null, entityLabel: String(username),
      action: 'login_failed', actor: found ?? null,
      reason: 'Credenciales incorrectas.', req,
    });
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  if (!found.active) {
    audit({ entityType: 'auth', entityId: found.id, entityLabel: found.username,
      action: 'login_denied', actor: found, reason: 'Usuario desactivado.', req });
    return res.status(403).json({ error: 'Su usuario está desactivado. Contacte al administrador.' });
  }

  const user = withPermissions(found);
  const { token, expiresAt } = createSession(user, req);
  audit({ entityType: 'auth', entityId: user.id, entityLabel: user.username,
    action: 'login', actor: user, after: { rol: user.role_name }, req });

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    expires: expiresAt,
  });
  res.json({ user: publicUser(user), hotel: getSetting('hotel_name', 'Hotel Quartz') });
}));

router.post('/logout', asyncRoute((req, res) => {
  if (req.user) {
    audit({ entityType: 'auth', entityId: req.user.id, entityLabel: req.user.username,
      action: 'logout', actor: req.user, req });
  }
  revokeSession(req.sessionToken);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), hotel: getSetting('hotel_name', 'Hotel Quartz') });
});

router.post('/password', requireAuth, asyncRoute((req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
  }
  const row = one('SELECT password_hash FROM users WHERE id = @id', { id: req.user.id });
  if (!verifyPassword(String(currentPassword ?? ''), row.password_hash)) {
    audit({ entityType: 'user', entityId: req.user.id, entityLabel: req.user.username,
      action: 'password_change_failed', actor: req.user, reason: 'Contraseña actual incorrecta.', req });
    return res.status(401).json({ error: 'La contraseña actual no es correcta.' });
  }
  update('users', req.user.id, {
    password_hash: hashPassword(String(newPassword)),
    must_change_password: 0,
    updated_at: new Date().toISOString(),
  });
  audit({ entityType: 'user', entityId: req.user.id, entityLabel: req.user.username,
    action: 'password_change', actor: req.user, reason: 'Cambio de contraseña por el propio usuario.', req });
  res.json({ ok: true, user: publicUser(withPermissions(getUserById(req.user.id))) });
}));

export default router;
