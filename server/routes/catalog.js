import express from 'express';
import { all, one } from '../lib/db.js';
import { requireAuth, requirePermission, asyncRoute } from '../middleware/auth.js';
import { photoPath } from '../lib/uploads.js';
import { getSetting } from '../lib/settings.js';
import { getTimezone } from '../lib/time.js';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/db.js';

/**
 * Logo del hotel. Basta con dejar logo.svg/.png/.jpg/.webp en public/assets
 * para que la interfaz lo use; si no hay ninguno, cae en la marca de texto.
 */
function logoUrl() {
  const dir = path.join(ROOT, 'public', 'assets');
  for (const ext of ['svg', 'png', 'webp', 'jpg', 'jpeg']) {
    const archivo = path.join(dir, `logo.${ext}`);
    if (fs.existsSync(archivo)) {
      // La marca de tiempo evita servir una versión cacheada tras sustituirlo.
      // Relativa, como el resto de la interfaz: bajo un prefijo la absoluta daba 404.
      return `assets/logo.${ext}?v=${Math.trunc(fs.statSync(archivo).mtimeMs)}`;
    }
  }
  return null;
}

const router = express.Router();

/** Marca del hotel para la pantalla de acceso, antes de iniciar sesión. */
router.get('/bootstrap/logo', asyncRoute((req, res) => {
  res.json({ logo: logoUrl(), hotel: getSetting('hotel_name', 'Hotel Quartz') });
}));

/** Catálogos que la interfaz necesita al arrancar. */
router.get('/bootstrap', requireAuth, asyncRoute((req, res) => {
  res.json({
    hotel: {
      name: getSetting('hotel_name', 'Hotel Quartz'),
      app: getSetting('app_name', 'CDH'),
      timezone: getTimezone(),
      targetRooms: Number(getSetting('target_room_count', 155)),
      bulkMaxRooms: Number(getSetting('bulk_max_rooms', 40)),
      logo: logoUrl(),
    },
    floors: all(`
      SELECT f.id, f.number, f.name, f.sort_order,
             COUNT(r.id) FILTER (WHERE r.active = 1) AS rooms
        FROM floors f LEFT JOIN rooms r ON r.floor_id = f.id
       WHERE f.active = 1 GROUP BY f.id ORDER BY f.sort_order`),
    statuses: all('SELECT * FROM room_statuses WHERE active = 1 ORDER BY sort_order'),
    departments: all('SELECT * FROM departments WHERE active = 1 ORDER BY sort_order'),
    categories: all(`
      SELECT c.*, d.name AS department_name FROM categories c
        LEFT JOIN departments d ON d.id = c.department_id
       WHERE c.active = 1 ORDER BY c.sort_order`),
    roomTypes: all('SELECT * FROM room_types WHERE active = 1 ORDER BY sort_order'),
    users: all(`
      SELECT u.id, u.full_name, u.username, d.name AS department_name
        FROM users u LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.active = 1 ORDER BY u.full_name`),
    recurrenceThresholds: String(getSetting('recurrence_thresholds', '2,3,5,10'))
      .split(',').map((n) => Number(n.trim())).filter(Boolean),
  });
}));

/** Fotografías: se sirven sólo a usuarios autenticados con permiso de ver. */
router.get('/photos/:id', requireAuth, requirePermission('room.view'), asyncRoute((req, res) => {
  const att = one('SELECT * FROM attachments WHERE id = @id', { id: Number(req.params.id) });
  if (!att) return res.status(404).json({ error: 'Fotografía no encontrada.' });
  const file = photoPath(att.filename);
  if (!file) return res.status(410).json({ error: 'El archivo ya no está disponible en el servidor.' });
  res.type(att.mime_type ?? 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
}));

/** Bitácora de auditoría: QUÉ, QUIÉN, CUÁNDO, DÓNDE, ANTES, DESPUÉS y POR QUÉ. */
router.get('/audit', requireAuth, requirePermission('audit.view'), asyncRoute((req, res) => {
  const where = ['1 = 1']; const params = {
    limit: Math.min(Number(req.query.limit ?? 100), 500),
    offset: Number(req.query.offset ?? 0),
  };
  if (req.query.entityType) { where.push('entity_type = @entityType'); params.entityType = req.query.entityType; }
  if (req.query.action)     { where.push('action = @action');          params.action = req.query.action; }
  if (req.query.userId)     { where.push('actor_user_id = @userId');   params.userId = Number(req.query.userId); }
  if (req.query.roomId)     { where.push('room_id = @roomId');         params.roomId = Number(req.query.roomId); }
  if (req.query.from)       { where.push('local_date >= @from');       params.from = req.query.from; }
  if (req.query.to)         { where.push('local_date <= @to');         params.to = req.query.to; }

  const sql = `FROM audit_log WHERE ${where.join(' AND ')}`;
  res.json({
    total: one(`SELECT COUNT(*) AS n ${sql}`, params).n,
    entityTypes: all('SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type').map((r) => r.entity_type),
    actions: all('SELECT DISTINCT action FROM audit_log ORDER BY action').map((r) => r.action),
    items: all(`SELECT * ${sql} ORDER BY created_epoch DESC, id DESC LIMIT @limit OFFSET @offset`, params),
  });
}));

/**
 * Notificaciones: sólo eventos relevantes, y sólo para quien le tocan.
 * Quien puede atender notificaciones (Gerencia, Supervisión, Administración)
 * las ve todas; el resto ve las dirigidas a su departamento, más las
 * generales, que no llevan destinatario.
 */
router.get('/notifications', requireAuth, asyncRoute((req, res) => {
  const veTodo = req.user.permissions.includes('notification.manage');
  const items = all(`
    SELECT n.*, (nr.read_at IS NOT NULL) AS is_read,
           (SELECT GROUP_CONCAT(d.name, ', ')
              FROM notification_recipients rc
              JOIN departments d ON d.id = rc.department_id
             WHERE rc.notification_id = n.id) AS recipients
      FROM notifications n
      LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = @user
     WHERE n.resolved_at IS NULL
       AND (@veTodo = 1
            OR NOT EXISTS (SELECT 1 FROM notification_recipients r WHERE r.notification_id = n.id)
            OR EXISTS (SELECT 1 FROM notification_recipients r
                        WHERE r.notification_id = n.id AND r.department_id = @dept))
     ORDER BY CASE n.severity WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 ELSE 2 END,
              n.created_epoch DESC
     LIMIT 50`, { user: req.user.id, veTodo: veTodo ? 1 : 0, dept: req.user.department_id ?? -1 });
  res.json({ total: items.length, unread: items.filter((i) => !i.is_read).length, items });
}));

router.post('/notifications/:id/read', requireAuth, asyncRoute((req, res) => {
  const id = Number(req.params.id);
  if (!one('SELECT id FROM notifications WHERE id = @id', { id })) {
    return res.status(404).json({ error: 'Notificación no encontrada.' });
  }
  one(`INSERT INTO notification_reads (notification_id, user_id, read_at)
       VALUES (@id, @user, @now)
       ON CONFLICT DO NOTHING RETURNING notification_id`,
    { id, user: req.user.id, now: new Date().toISOString() });
  res.json({ ok: true });
}));

router.post('/notifications/:id/resolve', requireAuth, requirePermission('notification.manage'), asyncRoute((req, res) => {
  const id = Number(req.params.id);
  const notif = one('SELECT * FROM notifications WHERE id = @id', { id });
  if (!notif) return res.status(404).json({ error: 'Notificación no encontrada.' });
  one(`UPDATE notifications SET resolved_at = @now, resolved_by = @user
        WHERE id = @id RETURNING id`,
    { id, now: new Date().toISOString(), user: req.user.id });
  res.json({ ok: true });
}));

export default router;
