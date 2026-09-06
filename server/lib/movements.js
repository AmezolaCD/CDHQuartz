import crypto from 'node:crypto';
import { db, one, all, insert, update, transaction } from './db.js';
import { stamp } from './time.js';
import { audit, clientIp } from './audit.js';
import { getSettingBool, getSettingNumber } from './settings.js';

export class MovementError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const parseJson = (v, fb) => { try { return v ? JSON.parse(v) : fb; } catch { return fb; } };

export const ROOM_SQL = `
  SELECT r.*, f.number AS floor_number, f.name AS floor_name,
         s.code AS status_code, s.name AS status_name, s.icon AS status_icon,
         s.color AS status_color, s.counts_attention, s.counts_blocked,
         s.counts_ready, s.counts_cleaning, s.counts_maintenance, s.counts_pending,
         t.code AS type_code, t.name AS type_name,
         u.full_name AS updated_by_name
    FROM rooms r
    JOIN floors f ON f.id = r.floor_id
    JOIN room_statuses s ON s.id = r.status_id
    LEFT JOIN room_types t ON t.id = r.room_type_id
    LEFT JOIN users u ON u.id = r.updated_by`;

export function getRoom(id) {
  return one(`${ROOM_SQL} WHERE r.id = @id`, { id });
}

export function getRoomByNumber(number) {
  return one(`${ROOM_SQL} WHERE r.number = @number`, { number: String(number) });
}

export function getFieldMap() {
  const rows = all(`
    SELECT f.*, c.code AS category_code, c.name AS category_name,
           c.department_id AS category_department_id
      FROM fields f JOIN categories c ON c.id = f.category_id
     WHERE f.active = 1 AND c.active = 1`);
  const byCode = new Map();
  const byId = new Map();
  for (const r of rows) {
    const f = { ...r, optionList: parseJson(r.options, []), incidentValues: parseJson(r.is_incident_when, []) };
    byCode.set(r.code, f); byId.set(r.id, f);
  }
  return { byCode, byId, list: [...byCode.values()] };
}

export function isIncidentValue(field, value) {
  return !!value && (field.incidentValues ?? []).includes(value);
}

/**
 * Verifica que el usuario puede escribir en una categoría.
 * Los roles con `department_scope` sólo escriben en categorías de su
 * departamento o en categorías generales (sin departamento asignado).
 */
export function canWriteCategory(user, categoryDepartmentId) {
  if (!user.department_scope) return true;
  if (categoryDepartmentId === null || categoryDepartmentId === undefined) return true;
  return categoryDepartmentId === user.department_id;
}

function has(user, code) { return (user.permissions ?? []).includes(code); }

/**
 * OPERACIÓN TRANSACCIONAL ÚNICA:
 *   1) actualiza el estado actual (rooms / room_details)
 *   2) crea el o los movimientos del historial (inmutables)
 *   3) escribe la bitácora de auditoría
 *   4) adjunta fotografías y genera notificaciones
 * Si cualquier paso falla, se revierte TODO.
 */
export function recordMovement({
  roomId, user, req,
  movementTypeCode = null,
  statusCode = null,
  details = [],
  comment = null,
  photos = [],
  correctsMovementId = null,
}) {
  if (!has(user, 'movement.create')) throw new MovementError('No tiene permiso para crear movimientos.', 403);

  const fields = getFieldMap();
  const t = stamp();
  const batchId = crypto.randomUUID();
  const ip = clientIp(req);

  return transaction(() => {
    const room = getRoom(roomId);
    if (!room) throw new MovementError('Habitación no encontrada.', 404);
    if (!room.active) throw new MovementError('La habitación está desactivada; no admite movimientos.', 409);

    const mtype = movementTypeCode
      ? one(`SELECT mt.*, c.code AS category_code, c.name AS category_name,
                    c.department_id AS category_department_id
               FROM movement_types mt
               LEFT JOIN categories c ON c.id = mt.category_id
              WHERE mt.code = @code AND mt.active = 1`, { code: movementTypeCode })
      : null;
    if (movementTypeCode && !mtype) throw new MovementError(`Tipo de movimiento desconocido: ${movementTypeCode}`, 400);
    // Un reporte se levanta HACIA otra área: Ama de Llaves debe poder avisar a
    // Mantenimiento o a Sistemas. Iniciar o cerrar el trabajo sigue siendo del
    // área responsable, y eso sí respeta el alcance por departamento.
    if (mtype && !mtype.cross_department && !canWriteCategory(user, mtype.category_department_id)) {
      throw new MovementError(`Su rol no puede registrar movimientos de la categoría ${mtype.category_name}.`, 403);
    }
    if (mtype?.requires_comment && !String(comment ?? '').trim()) {
      throw new MovementError(`La acción "${mtype.name}" requiere un comentario.`, 400);
    }
    if (mtype?.requires_photo && !photos.length) {
      throw new MovementError(`La acción "${mtype.name}" requiere al menos una fotografía.`, 400);
    }
    if (correctsMovementId && !one('SELECT id FROM movements WHERE id = @id', { id: correctsMovementId })) {
      throw new MovementError('El movimiento a corregir no existe.', 404);
    }

    // ------------------------------------------------- 1. Estado destino
    let newStatus = null;
    const requestedStatus = statusCode ?? (mtype?.target_status_id
      ? one('SELECT code FROM room_statuses WHERE id = @id', { id: mtype.target_status_id })?.code
      : null);
    if (requestedStatus && requestedStatus !== room.status_code) {
      if (!has(user, 'room.status')) throw new MovementError('No tiene permiso para cambiar el estado de la habitación.', 403);
      newStatus = one('SELECT * FROM room_statuses WHERE code = @c AND active = 1', { c: requestedStatus });
      if (!newStatus) throw new MovementError(`Estado desconocido o inactivo: ${requestedStatus}`, 400);
    }

    // ------------------------------------------- 2. Cambios en los detalles
    const detailChanges = [];
    for (const d of details ?? []) {
      const field = fields.byCode.get(d.fieldCode);
      if (!field) throw new MovementError(`Campo desconocido: ${d.fieldCode}`, 400);
      if (!has(user, 'room.edit')) throw new MovementError('No tiene permiso para editar detalles de habitación.', 403);
      if (!canWriteCategory(user, field.category_department_id)) {
        throw new MovementError(`Su rol no puede modificar campos de ${field.category_name}.`, 403);
      }
      if (field.type === 'select' && field.optionList.length && d.value && !field.optionList.includes(d.value)) {
        throw new MovementError(`Valor inválido para ${field.label}: ${d.value}`, 400);
      }
      const current = one(
        'SELECT * FROM room_details WHERE room_id = @r AND field_id = @f', { r: room.id, f: field.id });
      const oldValue = current?.value ?? null;
      const newValue = d.value === '' ? null : (d.value ?? null);
      if (String(oldValue ?? '') === String(newValue ?? '')) continue; // sin cambio real
      detailChanges.push({ field, oldValue, newValue, current });
    }

    const hasPrimary = !!mtype || !!newStatus || !!String(comment ?? '').trim() || photos.length > 0;
    if (!hasPrimary && !detailChanges.length) {
      throw new MovementError('No hay cambios que registrar.', 400);
    }

    // -------------------------------- 3. Actualizar el ESTADO ACTUAL
    const createdIds = [];
    const baseRow = {
      room_id: room.id,
      room_number: room.number,
      floor_id: room.floor_id,
      floor_number: room.floor_number,
      user_id: user.id,
      user_name: user.full_name,
      department_id: user.department_id ?? null,
      department_name: user.department_name ?? null,
      comment: String(comment ?? '').trim() || null,
      corrects_movement_id: correctsMovementId,
      batch_id: batchId,
      created_at: t.iso,
      created_epoch: t.epoch,
      local_date: t.localDate,
      local_time: t.localTime,
      timezone: t.timezone,
      ip,
    };

    let primaryId = null;
    let notifySeverity = null;

    if (hasPrimary) {
      const incident = mtype?.is_incident ? 1 : 0;
      const severity = mtype?.severity ?? 'normal';
      primaryId = insert('movements', {
        ...baseRow,
        category_id: mtype?.category_id ?? null,
        category_name: mtype?.category_name ?? null,
        movement_type_id: mtype?.id ?? null,
        action: mtype?.name ?? (newStatus ? 'Cambio de estado' : 'Observación'),
        action_code: mtype?.code ?? (newStatus ? 'STATUS_CHANGE' : 'NOTE'),
        field_label: newStatus ? 'Estado' : null,
        old_value: newStatus ? room.status_name : null,
        new_value: newStatus ? newStatus.name : null,
        old_status_id: room.status_id,
        new_status_id: newStatus ? newStatus.id : room.status_id,
        old_status_name: room.status_name,
        new_status_name: newStatus ? newStatus.name : room.status_name,
        severity,
        is_incident: incident,
        closes_incident: mtype?.closes_incident ?? 0,
        photo_count: photos.length,
      });
      createdIds.push(primaryId);
      if (incident || mtype?.notify) notifySeverity = severity;
    }

    // Un movimiento por cada campo modificado: campo, valor anterior, valor nuevo.
    for (const ch of detailChanges) {
      const incident = isIncidentValue(ch.field, ch.newValue) ? 1 : 0;
      const closes = !incident && isIncidentValue(ch.field, ch.oldValue) ? 1 : 0;
      const id = insert('movements', {
        ...baseRow,
        category_id: ch.field.category_id,
        category_name: ch.field.category_name,
        movement_type_id: one("SELECT id FROM movement_types WHERE code='DETAIL_UPDATE'")?.id ?? null,
        action: `Actualización de ${ch.field.label}`,
        action_code: 'DETAIL_UPDATE',
        field_id: ch.field.id,
        field_label: ch.field.label,
        old_value: ch.oldValue,
        new_value: ch.newValue,
        old_status_id: room.status_id,
        new_status_id: newStatus ? newStatus.id : room.status_id,
        old_status_name: room.status_name,
        new_status_name: newStatus ? newStatus.name : room.status_name,
        severity: incident ? 'alta' : 'normal',
        is_incident: incident,
        closes_incident: closes,
        photo_count: 0,
      });
      createdIds.push(id);
      if (!primaryId) primaryId = id;

      if (ch.current) {
        update('room_details', ch.current.id, {
          value: ch.newValue, updated_at: t.iso, updated_by: user.id, last_movement_id: id,
        });
      } else {
        insert('room_details', {
          room_id: room.id, field_id: ch.field.id, value: ch.newValue,
          updated_at: t.iso, updated_by: user.id, last_movement_id: id,
        });
      }
      if (incident && notifySeverity !== 'critica') notifySeverity = notifySeverity ?? 'alta';
    }

    update('rooms', room.id, {
      status_id: newStatus ? newStatus.id : room.status_id,
      status_changed_at: newStatus ? t.iso : room.status_changed_at,
      updated_at: t.iso,
      updated_by: user.id,
      last_movement_id: primaryId,
    });

    // ---------------------------------------------- 4. Fotografías
    const attachmentIds = [];
    for (const p of photos) {
      attachmentIds.push(insert('attachments', {
        movement_id: primaryId,
        room_id: room.id,
        user_id: user.id,
        user_name: user.full_name,
        kind: ['antes', 'despues', 'general'].includes(p.kind) ? p.kind : 'general',
        filename: p.filename,
        original_name: p.originalName ?? null,
        mime_type: p.mimeType ?? null,
        size_bytes: p.size ?? null,
        created_at: t.iso,
        local_date: t.localDate,
        local_time: t.localTime,
      }));
    }

    // ---------------------------------------------- 5. Notificaciones
    const finalStatus = newStatus ?? { code: room.status_code, name: room.status_name };
    const pideAviso = !!mtype?.notify || !!notifySeverity;
    if (pideAviso) {
      const isBlocked = ['BLOQUEADA', 'FUERA_SERVICIO'].includes(finalStatus.code);
      const severidad = notifySeverity ?? mtype?.severity ?? 'normal';
      // Los interruptores de configuración sólo silencian; no habilitan.
      const silenciado =
        (severidad === 'critica' && !getSettingBool('notify_critical', true)) ||
        (isBlocked && !getSettingBool('notify_blocked', true)) ||
        (mtype?.category_code === 'MTTO' && !getSettingBool('notify_maintenance', true));

      if (!silenciado) {
        const notifId = insert('notifications', {
          type: mtype?.code ?? 'INCIDENCIA',
          severity: severidad,
          title: `${room.number} — ${mtype?.name ?? 'Incidencia registrada'}`,
          body: baseRow.comment ?? `Estado: ${finalStatus.name}`,
          room_id: room.id,
          room_number: room.number,
          movement_id: primaryId,
          department_id: mtype?.category_department_id ?? user.department_id ?? null,
          created_at: t.iso,
          created_epoch: t.epoch,
        });

        // Destinatarios: el departamento al que se dirige el reporte y, si así
        // está configurado, siempre una copia a Ama de Llaves, que coordina el
        // piso y necesita saber tanto la apertura como el cierre.
        const destinos = new Set();
        if (mtype?.category_department_id) destinos.add(mtype.category_department_id);
        else if (user.department_id) destinos.add(user.department_id);
        if (getSettingBool('notify_housekeeping_copy', true)) {
          const ama = one("SELECT id FROM departments WHERE code = 'AMA' AND active = 1");
          if (ama) destinos.add(ama.id);
        }
        for (const departamento of destinos) {
          insert('notification_recipients', { notification_id: notifId, department_id: departamento });
        }
      }
    }

    // ---------------------------------------------- 6. Auditoría
    audit({
      entityType: 'room',
      entityId: room.id,
      entityLabel: `Habitación ${room.number}`,
      action: 'movement',
      actor: user,
      before: {
        estado: room.status_name,
        ...Object.fromEntries(detailChanges.map((c) => [c.field.label, c.oldValue])),
      },
      after: {
        estado: finalStatus.name,
        ...Object.fromEntries(detailChanges.map((c) => [c.field.label, c.newValue])),
      },
      reason: baseRow.comment,
      movementId: primaryId,
      roomId: room.id,
      req,
    });

    return {
      batchId,
      movementIds: createdIds,
      primaryId,
      attachments: attachmentIds.length,
      room: getRoom(room.id),
      statusChanged: !!newStatus,
      detailsChanged: detailChanges.length,
    };
  })();
}

/**
 * CAMBIO EN BLOQUE: la misma acción sobre varias habitaciones.
 *
 * No es un atajo que escriba por su cuenta: llama a `recordMovement` una vez
 * por habitación, así que cada una conserva su propio movimiento con su
 * historial, su auditoría y su notificación. Lo que agrega es que las N
 * operaciones ocurren dentro de UNA sola transacción: si una falla, ninguna
 * queda registrada. El lote comparte `bulkId`, de modo que la auditoría puede
 * responder "estos 12 movimientos fueron un mismo cambio en bloque".
 *
 * Las habitaciones que ya estaban en el estado destino y no traen nada más que
 * registrar se omiten en vez de abortar el lote: seleccionar un piso completo
 * y marcar "Limpieza terminada" no debe fallar porque tres ya lo estuvieran.
 */
export function recordBulkMovement({
  roomIds, user, req,
  movementTypeCode = null,
  statusCode = null,
  details = [],
  comment = null,
}) {
  if (!has(user, 'movement.create')) throw new MovementError('No tiene permiso para crear movimientos.', 403);

  const ids = [...new Set((roomIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw new MovementError('Seleccione al menos una habitación.', 400);

  const max = getSettingNumber('bulk_max_rooms', 40);
  if (ids.length > max) {
    throw new MovementError(`El cambio en bloque admite hasta ${max} habitaciones a la vez; seleccionó ${ids.length}.`, 400);
  }
  if (!movementTypeCode && !statusCode && !(details ?? []).length && !String(comment ?? '').trim()) {
    throw new MovementError('Elija una acción o un estado para aplicar.', 400);
  }

  const bulkId = crypto.randomUUID();

  return transaction(() => {
    // El estado destino se resuelve una vez: es el mismo para todo el lote.
    const targetCode = statusCode ?? (movementTypeCode
      ? one(`SELECT s.code FROM movement_types mt
               LEFT JOIN room_statuses s ON s.id = mt.target_status_id
              WHERE mt.code = @code AND mt.active = 1`, { code: movementTypeCode })?.code
      : null);

    const aplicadas = [];
    const omitidas = [];

    for (const roomId of ids) {
      const room = getRoom(roomId);
      if (!room) throw new MovementError(`Habitación ${roomId} no encontrada.`, 404);
      if (!room.active) { omitidas.push({ number: room.number, motivo: 'desactivada' }); continue; }

      // Sin acción, sin comentario y ya en el estado destino: no hay nada que
      // contar. Registrarlo sería ruido en el historial de esa habitación.
      const sinCambio = !movementTypeCode && !(details ?? []).length
        && !String(comment ?? '').trim() && room.status_code === targetCode;
      if (sinCambio) { omitidas.push({ number: room.number, motivo: 'ya estaba en ese estado' }); continue; }

      try {
        const r = recordMovement({
          roomId, user, req, movementTypeCode, statusCode, details, comment, photos: [],
        });
        aplicadas.push({
          roomId, number: r.room.number, floor: r.room.floor_name,
          batchId: r.batchId, movementId: r.primaryId,
          statusBefore: room.status_name, status: r.room.status_name,
          statusChanged: r.statusChanged,
        });
      } catch (err) {
        // El error se enriquece con la habitación: "618: requiere comentario"
        // dice qué corregir; "requiere comentario" a secas, no.
        if (err instanceof MovementError) throw new MovementError(`Habitación ${room.number}: ${err.message}`, err.status);
        throw err;
      }
    }

    if (!aplicadas.length) {
      throw new MovementError(
        omitidas.length
          ? `Ninguna habitación cambió: ${omitidas.map((o) => `${o.number} (${o.motivo})`).join(', ')}.`
          : 'No hay cambios que registrar.', 400);
    }

    audit({
      entityType: 'bulk',
      entityId: bulkId,
      entityLabel: `Cambio en bloque · ${aplicadas.length === 1 ? '1 habitación' : `${aplicadas.length} habitaciones`}`,
      action: 'bulk_movement',
      actor: user,
      before: { estados: Object.fromEntries(aplicadas.map((a) => [a.number, a.statusBefore])) },
      after: {
        accion: movementTypeCode ?? 'Cambio de estado',
        estados: Object.fromEntries(aplicadas.map((a) => [a.number, a.status])),
        omitidas: omitidas.map((o) => `${o.number} (${o.motivo})`),
      },
      reason: String(comment ?? '').trim() || null,
      req,
    });

    return { bulkId, aplicadas, omitidas, total: ids.length };
  })();
}
