import express from 'express';
import { all } from '../lib/db.js';
import { requireAuth, requirePermission, asyncRoute } from '../middleware/auth.js';
import {
  priorities, listRequests, pendingSummary, pmsNotice,
  requestCleaning, attendRequest, cancelRequest,
} from '../lib/cleaning.js';
import { MovementError } from '../lib/movements.js';
import { getSettingNumber } from '../lib/settings.js';

const router = express.Router();
router.use(requireAuth, requirePermission('room.view'));

const int = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

function listasParaEntregar(floorId = null, limit = null) {
  return all(`
    SELECT r.id, r.number, r.floor_id, f.name AS floor_name,
           s.code AS status_code, s.name AS status_name, s.color AS status_color,
           r.status_changed_at
      FROM rooms r
      JOIN floors f ON f.id = r.floor_id
      JOIN room_statuses s ON s.id = r.status_id
     WHERE r.active = 1 AND s.active = 1 AND s.counts_ready = 1
       ${floorId ? 'AND r.floor_id = @floorId' : ''}
       AND NOT EXISTS (SELECT 1 FROM cleaning_requests c
                        WHERE c.room_id = r.id AND c.status = 'pendiente')
     ORDER BY COALESCE(r.status_changed_at, r.created_at), CAST(r.number AS INTEGER)
     ${limit ? 'LIMIT @limit' : ''}`, { ...(floorId ? { floorId } : {}), ...(limit ? { limit } : {}) });
}

/**
 * El centro: la cola pendiente, lo ya resuelto y las habitaciones limpias
 * listas para entregar. Todo lo que la vista necesita en una sola llamada.
 */
router.get('/', asyncRoute((req, res) => {
  const floorId = int(req.query.floorId);
  res.json({
    priorities: priorities(),
    summary: pendingSummary(floorId),
    pending: listRequests({ status: 'pendiente', floorId, priority: req.query.priority || null }),
    resolved: listRequests({ status: req.query.resolved === 'canceladas' ? 'cancelada' : 'atendida', floorId, limit: 40 }),
    // Limpias y sin huésped: las que Recepción puede tomar para entregar.
    // Primero las que llevan más tiempo listas —se rota el inventario en vez
    // de entregar siempre las mismas— y fuera las que tienen limpieza pedida:
    // si Ama de Llaves todavía tiene que subir, no está para entregarse.
    ready: listasParaEntregar(floorId, 60),
    readyTotal: listasParaEntregar(floorId).length,
    pmsNotice: pmsNotice(),
    canRequest: req.user.permissions.includes('cleaning.request'),
    maxRooms: getSettingNumber('bulk_max_rooms', 40),
  });
}));

/** Historial de una habitación en el centro: qué se pidió y cómo terminó. */
router.get('/rooms/:id', asyncRoute((req, res) => {
  res.json({
    requests: all(`
      SELECT * FROM cleaning_requests WHERE room_id = @id
       ORDER BY requested_epoch DESC LIMIT 20`, { id: int(req.params.id) }),
  });
}));

/**
 * Pedir limpieza. Admite una habitación o varias: Recepción suele pedir el
 * piso entero de un turno, y hacerlo de una en una invita a saltarse alguna.
 */
router.post('/requests', requirePermission('cleaning.request'), asyncRoute((req, res) => {
  const ids = [...new Set(
    (Array.isArray(req.body.roomIds) ? req.body.roomIds : [req.body.roomId])
      .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw new MovementError('Seleccione al menos una habitación.', 400);

  const max = getSettingNumber('bulk_max_rooms', 40);
  if (ids.length > max) {
    throw new MovementError(`Se admiten hasta ${max} habitaciones a la vez; seleccionó ${ids.length}.`, 400);
  }

  const creadas = []; const elevadas = []; const sinCambio = [];
  for (const roomId of ids) {
    const r = requestCleaning({
      roomId, user: req.user, req,
      priorityCode: req.body.priority,
      note: req.body.note ?? null,
    });
    if (r.creada) creadas.push(r.request);
    else if (r.elevada) elevadas.push(r.request);
    else sinCambio.push(r.request);
  }
  res.status(201).json({ creadas, elevadas, sinCambio, summary: pendingSummary() });
}));

router.post('/requests/:id/attend', requirePermission('cleaning.request'), asyncRoute((req, res) => {
  res.json({
    request: attendRequest({ id: int(req.params.id), user: req.user, req, note: req.body?.note ?? null }),
    summary: pendingSummary(),
  });
}));

router.post('/requests/:id/cancel', requirePermission('cleaning.request'), asyncRoute((req, res) => {
  res.json({
    request: cancelRequest({ id: int(req.params.id), user: req.user, req, reason: req.body?.reason ?? null }),
    summary: pendingSummary(),
  });
}));

export default router;
