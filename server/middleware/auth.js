import { COOKIE_NAME, resolveSession } from '../lib/auth.js';

export function attachUser(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const resolved = resolveSession(token);
  req.user = resolved?.user ?? null;
  req.sessionToken = resolved ? token : null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sesión no iniciada o expirada.' });
  next();
}

/** Exige uno o más permisos (todos deben estar presentes). */
export function requirePermission(...codes) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sesión no iniciada o expirada.' });
    const missing = codes.filter((c) => !req.user.permissions.includes(c));
    if (missing.length) {
      return res.status(403).json({
        error: 'No tiene permisos para esta operación.',
        required: codes, missing,
      });
    }
    next();
  };
}

/** Envuelve un handler async y canaliza los errores al middleware de errores. */
export function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
