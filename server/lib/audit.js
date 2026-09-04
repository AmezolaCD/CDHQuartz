import { insert } from './db.js';
import { stamp } from './time.js';

/**
 * Escribe una entrada en la bitácora inmutable.
 * Responde QUÉ, QUIÉN, CUÁNDO, DÓNDE, ANTES, DESPUÉS y POR QUÉ.
 * Debe invocarse dentro de la misma transacción que el cambio que describe.
 */
export function audit({
  entityType, entityId = null, entityLabel = null, action,
  actor = null, before = null, after = null, reason = null,
  movementId = null, roomId = null, req = null, departmentId = null,
}) {
  const t = stamp();
  return insert('audit_log', {
    entity_type: entityType,
    entity_id: entityId === null ? null : String(entityId),
    entity_label: entityLabel,
    action,
    actor_user_id: actor?.id ?? null,
    actor_name: actor?.full_name ?? actor?.username ?? 'sistema',
    actor_role: actor?.role_code ?? null,
    department_id: departmentId ?? actor?.department_id ?? null,
    before_json: before ? JSON.stringify(before) : null,
    after_json: after ? JSON.stringify(after) : null,
    reason,
    movement_id: movementId,
    room_id: roomId,
    ip: clientIp(req),
    user_agent: req?.headers?.['user-agent']?.slice(0, 400) ?? null,
    created_at: t.iso,
    created_epoch: t.epoch,
    local_date: t.localDate,
    local_time: t.localTime,
  });
}

export function clientIp(req) {
  if (!req) return null;
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

/** Diferencia campo a campo entre dos objetos, para `before`/`after`. */
export function diff(before, after, keys) {
  const b = {}; const a = {};
  for (const k of keys ?? Object.keys(after ?? {})) {
    const ov = before?.[k] ?? null;
    const nv = after?.[k] ?? null;
    if (String(ov ?? '') !== String(nv ?? '')) { b[k] = ov; a[k] = nv; }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}
