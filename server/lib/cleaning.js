// ============================================================================
// Centro de solicitudes de limpieza.
//
// Recepción pide, Ama de Llaves atiende. Una solicitud es ESTADO ACTUAL —una
// cola de trabajo que se vacía—, no historial: vive en su propia tabla, como
// `rooms`. Lo inmutable es el movimiento que cada cambio suyo deja en el
// expediente de la habitación, y por eso todo pasa por `recordMovement`: la
// solicitud hereda gratis su auditoría, su notificación y su sello de tiempo.
// ============================================================================
import { one, all, insert, update, transaction } from './db.js';
import { stamp } from './time.js';
import { getSetting, getSettingBool } from './settings.js';
import { recordMovement, MovementError, getRoom } from './movements.js';

/** Prioridades vigentes, de la más urgente a la menos. */
export function priorities() {
  return all(`SELECT * FROM cleaning_priorities WHERE active = 1
               ORDER BY weight DESC, sort_order`);
}

export function priorityByCode(code) {
  return one('SELECT * FROM cleaning_priorities WHERE code = @code AND active = 1', { code });
}

const SOLICITUD_SQL = `
  SELECT s.*, r.active AS room_active,
         st.code AS status_code, st.name AS status_name,
         st.icon AS status_icon, st.color AS status_color,
         st.counts_cleaning, st.counts_ready,
         f.name AS floor_name,
         p.icon AS priority_icon, p.color AS priority_color
    FROM cleaning_requests s
    JOIN rooms r ON r.id = s.room_id
    JOIN room_statuses st ON st.id = r.status_id
    JOIN floors f ON f.id = s.floor_id
    LEFT JOIN cleaning_priorities p ON p.id = s.priority_id`;

/**
 * La cola: primero lo más urgente y, a igual prioridad, lo que lleva más
 * tiempo esperando. Quien la atiende no tiene que decidir por dónde empezar.
 */
export function listRequests({ status = 'pendiente', floorId = null, priority = null, limit = 200 } = {}) {
  const where = ['1 = 1']; const params = { limit: Math.min(Number(limit) || 200, 500) };
  if (status && status !== 'todas') { where.push('s.status = @status'); params.status = status; }
  if (floorId) { where.push('s.floor_id = @floorId'); params.floorId = Number(floorId); }
  if (priority) { where.push('s.priority_code = @priority'); params.priority = priority; }
  return all(`${SOLICITUD_SQL}
     WHERE ${where.join(' AND ')}
     ORDER BY CASE s.status WHEN 'pendiente' THEN 0 ELSE 1 END,
              s.priority_weight DESC, s.requested_epoch
     LIMIT @limit`, params);
}

export function pendingRequest(roomId) {
  return one(`${SOLICITUD_SQL} WHERE s.room_id = @roomId AND s.status = 'pendiente'`, { roomId });
}

/** Solicitud pendiente de cada habitación, para pintar el rack de un piso. */
export function pendingByRoom() {
  const map = new Map();
  for (const s of all(`${SOLICITUD_SQL} WHERE s.status = 'pendiente'`)) map.set(s.room_id, s);
  return map;
}

/** Resumen de la cola: total y reparto por prioridad, de mayor a menor. */
export function pendingSummary(floorId = null) {
  const params = floorId ? { floorId: Number(floorId) } : {};
  const filtro = floorId ? 'AND s.floor_id = @floorId' : '';
  const porPrioridad = all(`
    SELECT p.code, p.name, p.icon, p.color, p.weight,
           COUNT(s.id) AS solicitudes
      FROM cleaning_priorities p
      LEFT JOIN cleaning_requests s
             ON s.priority_id = p.id AND s.status = 'pendiente' ${filtro}
     WHERE p.active = 1
     GROUP BY p.id
     ORDER BY p.weight DESC`, params);
  const total = porPrioridad.reduce((n, p) => n + p.solicitudes, 0);
  // La más urgente que tenga algo esperando: es lo que se anuncia de un lote.
  const masUrgente = porPrioridad.find((p) => p.solicitudes > 0) ?? null;
  return { total, porPrioridad, masUrgente };
}

/**
 * Aviso de que el cambio hay que repetirlo en el PMS. Mientras los dos
 * sistemas no estén enlazados, la única garantía de que no se descuadren es
 * que quien opera lo tenga delante cada vez.
 */
export function pmsNotice() {
  if (!getSettingBool('pms_manual_sync', true)) return null;
  const pms = getSetting('pms_name', 'Arpón Enterprise');
  return `Este cambio hay que hacerlo también en ${pms}: los dos sistemas todavía no están enlazados.`;
}

/**
 * Pide limpieza para una habitación.
 *
 * Si ya hay una solicitud pendiente no se crea otra: o sube de prioridad, o se
 * queda como está. Dos solicitudes para la misma habitación no son dos
 * trabajos, y la cola tiene que decir cuánto falta por hacer, no cuántas veces
 * lo han pedido.
 */
export function requestCleaning({ roomId, user, req, priorityCode, note = null }) {
  if (!(user.permissions ?? []).includes('cleaning.request')) {
    throw new MovementError('No tiene permiso para solicitar limpieza.', 403);
  }
  const prioridad = priorityByCode(priorityCode);
  if (!prioridad) throw new MovementError(`Prioridad desconocida o inactiva: ${priorityCode}`, 400);

  return transaction(() => {
    const room = getRoom(roomId);
    if (!room) throw new MovementError('Habitación no encontrada.', 404);
    if (!room.active) throw new MovementError('La habitación está desactivada; no admite solicitudes.', 409);

    const abierta = pendingRequest(room.id);
    const comentario = String(note ?? '').trim() || null;

    if (abierta && prioridad.weight <= abierta.priority_weight) {
      return { request: abierta, creada: false, elevada: false, room };
    }

    const t = stamp();
    const detalle = [
      `${prioridad.name}${abierta ? ` (antes ${abierta.priority_name})` : ''}`,
      comentario,
    ].filter(Boolean).join(' · ');

    const mov = recordMovement({
      roomId: room.id, user, req,
      movementTypeCode: abierta ? 'CLEAN_REQUEST_RAISE' : 'CLEAN_REQUEST',
      comment: detalle,
    });

    if (abierta) {
      update('cleaning_requests', abierta.id, {
        priority_id: prioridad.id,
        priority_code: prioridad.code,
        priority_name: prioridad.name,
        priority_weight: prioridad.weight,
        note: comentario ?? abierta.note,
      });
      return { request: pendingRequest(room.id), creada: false, elevada: true, room: mov.room };
    }

    const id = insert('cleaning_requests', {
      room_id: room.id,
      room_number: room.number,
      floor_id: room.floor_id,
      floor_number: room.floor_number,
      priority_id: prioridad.id,
      priority_code: prioridad.code,
      priority_name: prioridad.name,
      priority_weight: prioridad.weight,
      status: 'pendiente',
      note: comentario,
      requested_by: user.id,
      requested_by_name: user.full_name,
      requested_department: user.department_name ?? null,
      requested_at: t.iso,
      requested_epoch: t.epoch,
      local_date: t.localDate,
      local_time: t.localTime,
      movement_id: mov.primaryId,
    });
    return { request: one(`${SOLICITUD_SQL} WHERE s.id = @id`, { id }), creada: true, elevada: false, room: mov.room };
  })();
}

/** Cierra una solicitud: atendida o cancelada, siempre con su movimiento. */
function cerrar({ id, user, req, estado, motivo, movementTypeCode }) {
  return transaction(() => {
    const solicitud = one(`${SOLICITUD_SQL} WHERE s.id = @id`, { id: Number(id) });
    if (!solicitud) throw new MovementError('Solicitud no encontrada.', 404);
    if (solicitud.status !== 'pendiente') {
      throw new MovementError(`La solicitud ya está ${solicitud.status}.`, 409);
    }
    const t = stamp();
    const comentario = String(motivo ?? '').trim() || null;
    const mov = recordMovement({
      roomId: solicitud.room_id, user, req, movementTypeCode,
      comment: [`${solicitud.priority_name}`, comentario].filter(Boolean).join(' · '),
    });
    update('cleaning_requests', solicitud.id, {
      status: estado,
      closed_by: user.id,
      closed_by_name: user.full_name,
      closed_at: t.iso,
      closed_epoch: t.epoch,
      closed_reason: comentario,
      closed_movement_id: mov.primaryId,
    });
    return one(`${SOLICITUD_SQL} WHERE s.id = @id`, { id: solicitud.id });
  })();
}

export function attendRequest({ id, user, req, note = null }) {
  if (!(user.permissions ?? []).includes('cleaning.request')) {
    throw new MovementError('No tiene permiso para atender solicitudes de limpieza.', 403);
  }
  return cerrar({ id, user, req, estado: 'atendida', motivo: note, movementTypeCode: 'CLEAN_REQUEST_DONE' });
}

export function cancelRequest({ id, user, req, reason = null }) {
  if (!(user.permissions ?? []).includes('cleaning.request')) {
    throw new MovementError('No tiene permiso para cancelar solicitudes de limpieza.', 403);
  }
  if (!String(reason ?? '').trim()) {
    throw new MovementError('Cancelar una solicitud necesita un motivo.', 400);
  }
  return cerrar({ id, user, req, estado: 'cancelada', motivo: reason, movementTypeCode: 'CLEAN_REQUEST_CANCEL' });
}

/**
 * Da por atendida la solicitud pendiente de una habitación porque alguien
 * acaba de limpiarla. Lo llama `recordMovement` dentro de su propia
 * transacción, así que aquí no se abre otra ni se crea un movimiento más: el
 * de la limpieza ya cuenta lo ocurrido.
 */
export function closeRequestOnClean({ room, user, movementId, t }) {
  const abierta = pendingRequest(room.id);
  if (!abierta) return null;
  update('cleaning_requests', abierta.id, {
    status: 'atendida',
    closed_by: user.id,
    closed_by_name: user.full_name,
    closed_at: t.iso,
    closed_epoch: t.epoch,
    closed_reason: 'La habitación se limpió.',
    closed_movement_id: movementId,
  });
  return abierta;
}
