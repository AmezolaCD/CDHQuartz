import { all, one } from './db.js';
import { getSettingNumber, getSetting } from './settings.js';
import { localDate, periodRange } from './time.js';

// Una incidencia está ABIERTA cuando el valor actual de un campo coincide con
// alguno de los valores marcados como incidencia en su configuración.
const OPEN_INCIDENTS_SQL = `
  SELECT rd.room_id, f.id AS field_id, f.label AS field_label, rd.value,
         c.code AS category_code, c.name AS category_name,
         c.department_id, rd.updated_at
    FROM room_details rd
    JOIN fields f ON f.id = rd.field_id AND f.active = 1
    JOIN categories c ON c.id = f.category_id AND c.active = 1
    JOIN rooms r ON r.id = rd.room_id AND r.active = 1
   WHERE f.is_incident_when IS NOT NULL
     AND rd.value IS NOT NULL
     AND EXISTS (SELECT 1 FROM json_each(f.is_incident_when) j WHERE j.value = rd.value)`;

export function openIncidents() {
  return all(OPEN_INCIDENTS_SQL);
}

export function openIncidentsByRoom() {
  const map = new Map();
  for (const i of openIncidents()) {
    if (!map.has(i.room_id)) map.set(i.room_id, []);
    map.get(i.room_id).push(i);
  }
  return map;
}

export function thresholds() {
  return String(getSetting('recurrence_thresholds', '2,3,5,10'))
    .split(',').map((n) => Number(n.trim())).filter(Boolean).sort((a, b) => a - b);
}

/** Habitaciones con múltiples incidencias dentro de la ventana indicada. */
export function recurrence({ from, to, minCount = 2 } = {}) {
  const window = getSettingNumber('recurrence_window_days', 30);
  const range = from && to ? { from, to } : { from: localDate(-window + 1), to: localDate(0) };
  const rows = all(`
    SELECT m.room_id, m.room_number, m.floor_number,
           -- Un reporte genera varios movimientos (acción + campos afectados);
           -- la reincidencia cuenta EVENTOS distintos, no filas.
           COUNT(DISTINCT m.batch_id) AS incidents,
           SUM(CASE WHEN m.severity = 'critica' THEN 1 ELSE 0 END) AS critical,
           MAX(m.created_epoch) AS last_epoch,
           MAX(m.local_date || ' ' || m.local_time) AS last_at
      FROM movements m
      JOIN rooms r ON r.id = m.room_id AND r.active = 1
     WHERE m.is_incident = 1
       AND m.local_date BETWEEN @from AND @to
     GROUP BY m.room_id
    HAVING COUNT(DISTINCT m.batch_id) >= @min
     ORDER BY incidents DESC, last_epoch DESC`,
    { from: range.from, to: range.to, min: minCount });

  const ths = thresholds();
  const buckets = ths.map((t) => ({
    threshold: t,
    label: `${t}+ incidencias`,
    rooms: rows.filter((r) => r.incidents >= t).length,
  }));
  return { range, window, rooms: rows, buckets, thresholds: ths };
}

/** Contadores del dashboard gerencial. */
export function overview() {
  const totals = one(`
    SELECT COUNT(*) AS total,
           SUM(s.counts_ready)       AS listas,
           SUM(s.counts_cleaning)    AS limpieza,
           SUM(s.counts_maintenance) AS mantenimiento,
           SUM(s.counts_blocked)     AS bloqueadas,
           SUM(s.counts_pending)     AS pendientes,
           SUM(s.counts_attention)   AS atencion
      FROM rooms r JOIN room_statuses s ON s.id = r.status_id
     WHERE r.active = 1`);

  const today = localDate(0);
  const movementsToday = one(
    `SELECT COUNT(*) AS n FROM movements WHERE local_date = @d`, { d: today }).n;
  const incidentsToday = one(
    `SELECT COUNT(*) AS n FROM movements WHERE local_date = @d AND is_incident = 1`, { d: today }).n;

  const incidents = openIncidents();
  const target = getSettingNumber('target_room_count', 155);

  return {
    total: totals.total ?? 0,
    target,
    inactivas: one('SELECT COUNT(*) AS n FROM rooms WHERE active = 0').n,
    listas: totals.listas ?? 0,
    limpieza: totals.limpieza ?? 0,
    mantenimiento: totals.mantenimiento ?? 0,
    bloqueadas: totals.bloqueadas ?? 0,
    pendientes: totals.pendientes ?? 0,
    requierenAtencion: totals.atencion ?? 0,
    incidenciasAbiertas: incidents.length,
    habitacionesConIncidencia: new Set(incidents.map((i) => i.room_id)).size,
    movimientosHoy: movementsToday,
    incidenciasHoy: incidentsToday,
    fecha: today,
  };
}

export function statusBreakdown(floorId = null) {
  return all(`
    SELECT s.id, s.code, s.name, s.icon, s.color, s.sort_order,
           COUNT(r.id) AS rooms
      FROM room_statuses s
      LEFT JOIN rooms r ON r.status_id = s.id AND r.active = 1
           ${floorId ? 'AND r.floor_id = @floorId' : ''}
     WHERE s.active = 1
     GROUP BY s.id
     ORDER BY s.sort_order`, floorId ? { floorId } : {});
}

/** Problemas agrupados por piso: base del dashboard por piso. */
export function problemsByFloor() {
  const incidents = openIncidentsByRoom();
  const floors = all(`
    SELECT f.id, f.number, f.name,
           COUNT(r.id) AS rooms,
           SUM(s.counts_ready)       AS listas,
           SUM(s.counts_cleaning)    AS limpieza,
           SUM(s.counts_maintenance) AS mantenimiento,
           SUM(s.counts_blocked)     AS bloqueadas,
           SUM(s.counts_pending)     AS pendientes,
           SUM(s.counts_attention)   AS atencion
      FROM floors f
      LEFT JOIN rooms r ON r.floor_id = f.id AND r.active = 1
      LEFT JOIN room_statuses s ON s.id = r.status_id
     WHERE f.active = 1
     GROUP BY f.id
     ORDER BY f.sort_order`);

  const byFloorIncidents = new Map();
  for (const [roomId, list] of incidents) {
    const fid = one('SELECT floor_id FROM rooms WHERE id = @id', { id: roomId })?.floor_id;
    byFloorIncidents.set(fid, (byFloorIncidents.get(fid) ?? 0) + list.length);
  }
  return floors.map((f) => ({ ...f, incidencias: byFloorIncidents.get(f.id) ?? 0 }));
}

export function problemsByDepartment({ from, to } = periodRange('mes')) {
  return all(`
    SELECT COALESCE(m.department_name, 'Sin departamento') AS departamento,
           m.department_id,
           COUNT(*) AS movimientos,
           SUM(m.is_incident) AS incidencias,
           SUM(CASE WHEN m.severity = 'critica' THEN 1 ELSE 0 END) AS criticas
      FROM movements m
     WHERE m.local_date BETWEEN @from AND @to
     GROUP BY m.department_id
     ORDER BY incidencias DESC, movimientos DESC`, { from, to });
}

/** Tendencia diaria de movimientos e incidencias. */
export function trend(days = 14) {
  const from = localDate(-(days - 1));
  const rows = all(`
    SELECT local_date AS fecha, COUNT(*) AS movimientos, SUM(is_incident) AS incidencias
      FROM movements WHERE local_date >= @from
     GROUP BY local_date ORDER BY local_date`, { from });
  const byDate = new Map(rows.map((r) => [r.fecha, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = localDate(-i);
    out.push(byDate.get(d) ?? { fecha: d, movimientos: 0, incidencias: 0 });
  }
  return out;
}

/**
 * Sección "Requiere atención": sólo lo accionable.
 * Mantenimiento pendiente, bloqueadas, incidencias críticas,
 * inspecciones pendientes y reincidencias.
 */
export function attention({ limit = 60 } = {}) {
  const incidents = openIncidentsByRoom();
  const rec = recurrence({ minCount: thresholds()[0] ?? 2 });
  const recByRoom = new Map(rec.rooms.map((r) => [r.room_id, r]));

  const rooms = all(`
    SELECT r.id, r.number, r.floor_id, f.number AS floor_number, f.name AS floor_name,
           s.code AS status_code, s.name AS status_name, s.icon AS status_icon,
           s.color AS status_color, s.counts_blocked, s.counts_maintenance,
           s.counts_attention, r.status_changed_at, r.updated_at,
           u.full_name AS updated_by_name
      FROM rooms r
      JOIN floors f ON f.id = r.floor_id
      JOIN room_statuses s ON s.id = r.status_id
      LEFT JOIN users u ON u.id = r.updated_by
     WHERE r.active = 1`);

  const items = [];
  for (const r of rooms) {
    const reasons = [];
    if (r.status_code === 'MANT_PENDIENTE') reasons.push({ code: 'mantenimiento', label: 'Mantenimiento pendiente', weight: 3 });
    if (r.counts_blocked) reasons.push({ code: 'bloqueada', label: `Habitación ${r.status_name.toLowerCase()}`, weight: 4 });
    if (r.status_code === 'INSPECCION_PENDIENTE') reasons.push({ code: 'inspeccion', label: 'Inspección pendiente', weight: 2 });

    const inc = incidents.get(r.id) ?? [];
    if (inc.length) {
      reasons.push({
        code: 'incidencia',
        label: inc.length === 1
          ? `Incidencia: ${inc[0].field_label} — ${inc[0].value}`
          : `${inc.length} incidencias abiertas`,
        weight: 3,
        detail: inc.map((i) => `${i.field_label}: ${i.value}`),
      });
    }
    const rr = recByRoom.get(r.id);
    if (rr) reasons.push({ code: 'reincidencia', label: `Reincidente: ${rr.incidents} incidencias en ${rec.window} días`, weight: 5 });

    if (reasons.length) {
      items.push({
        ...r,
        reasons,
        incidentCount: inc.length,
        recurrenceCount: rr?.incidents ?? 0,
        priority: Math.max(...reasons.map((x) => x.weight)),
      });
    }
  }

  items.sort((a, b) =>
    b.priority - a.priority ||
    b.recurrenceCount - a.recurrenceCount ||
    b.incidentCount - a.incidentCount ||
    a.number.localeCompare(b.number, 'es', { numeric: true }));

  return { total: items.length, items: items.slice(0, limit) };
}

/** Actividad reciente del hotel: hora, habitación, departamento y acción. */
export function recentActivity({ limit = 25, offset = 0, filters = {} } = {}) {
  const where = ['1 = 1']; const params = { limit, offset };
  if (filters.floorId)      { where.push('m.floor_id = @floorId');           params.floorId = filters.floorId; }
  if (filters.roomId)       { where.push('m.room_id = @roomId');             params.roomId = filters.roomId; }
  if (filters.departmentId) { where.push('m.department_id = @departmentId'); params.departmentId = filters.departmentId; }
  if (filters.userId)       { where.push('m.user_id = @userId');             params.userId = filters.userId; }
  if (filters.categoryId)   { where.push('m.category_id = @categoryId');     params.categoryId = filters.categoryId; }
  if (filters.incidentsOnly){ where.push('m.is_incident = 1'); }
  if (filters.from)         { where.push('m.local_date >= @from');           params.from = filters.from; }
  if (filters.to)           { where.push('m.local_date <= @to');             params.to = filters.to; }

  const sql = `FROM movements m WHERE ${where.join(' AND ')}`;
  return {
    total: one(`SELECT COUNT(*) AS n ${sql}`, params).n,
    items: all(`SELECT m.* ${sql} ORDER BY m.created_epoch DESC, m.id DESC LIMIT @limit OFFSET @offset`, params),
  };
}
