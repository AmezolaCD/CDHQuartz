import express from 'express';
import { all, one } from '../lib/db.js';
import { requireAuth, requirePermission, asyncRoute } from '../middleware/auth.js';
import { photoUpload, toPhotoRecords, discardFiles } from '../lib/uploads.js';
import {
  ROOM_SQL, getRoom, recordMovement, MovementError, getFieldMap, isIncidentValue, canWriteCategory,
} from '../lib/movements.js';
import { openIncidentsByRoom, recurrence, thresholds } from '../lib/stats.js';
import { getSettingNumber } from '../lib/settings.js';

const router = express.Router();
router.use(requireAuth, requirePermission('room.view'));

const int = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/** Tarjeta compacta de habitación para el mapa del piso. */
function decorate(rooms) {
  const incidents = openIncidentsByRoom();
  const rec = recurrence({ minCount: thresholds()[0] ?? 2 });
  const recByRoom = new Map(rec.rooms.map((r) => [r.room_id, r.incidents]));
  return rooms.map((r) => {
    const inc = incidents.get(r.id) ?? [];
    return {
      ...r,
      incidentCount: inc.length,
      incidents: inc.map((i) => ({ field: i.field_label, value: i.value, category: i.category_name })),
      recurrenceCount: recByRoom.get(r.id) ?? 0,
      needsAttention: !!r.counts_attention || inc.length > 0,
    };
  });
}

// ------------------------------------------------------------- Pisos y mapa
router.get('/floors', asyncRoute((req, res) => {
  res.json({
    floors: all(`
      SELECT f.id, f.number, f.name, f.sort_order, f.active,
             COUNT(r.id) AS rooms,
             SUM(CASE WHEN r.active = 1 THEN 1 ELSE 0 END) AS activeRooms
        FROM floors f
        LEFT JOIN rooms r ON r.floor_id = f.id
       WHERE f.active = 1
       GROUP BY f.id ORDER BY f.sort_order`),
  });
}));

/**
 * Mapa de un piso: sólo sus habitaciones, en la cuadrícula real.
 * Los espacios sin habitación quedan vacíos.
 */
router.get('/floors/:id/map', asyncRoute((req, res) => {
  const floor = one('SELECT * FROM floors WHERE id = @id', { id: int(req.params.id) });
  if (!floor) return res.status(404).json({ error: 'Piso no encontrado.' });

  const rooms = decorate(all(`${ROOM_SQL} WHERE r.floor_id = @id ORDER BY r.grid_col`, { id: floor.id }));
  const maxCol = Math.max(19, ...rooms.map((r) => r.grid_col));
  const byCol = new Map(rooms.map((r) => [r.grid_col, r]));
  const cells = Array.from({ length: maxCol }, (_, i) => byCol.get(i + 1) ?? null);

  const statusSummary = all(`
    SELECT s.code, s.name, s.icon, s.color, COUNT(r.id) AS rooms
      FROM room_statuses s
      JOIN rooms r ON r.status_id = s.id AND r.floor_id = @id AND r.active = 1
     GROUP BY s.id ORDER BY s.sort_order`, { id: floor.id });

  res.json({
    floor,
    columns: maxCol,
    cells,
    rooms,
    totals: {
      rooms: rooms.filter((r) => r.active).length,
      inactive: rooms.filter((r) => !r.active).length,
      attention: rooms.filter((r) => r.needsAttention).length,
    },
    statusSummary,
  });
}));

// ------------------------------------------------------------------ Búsqueda
/**
 * Búsqueda por habitación, piso, estado, departamento, usuario,
 * categoría o incidencia. Escribir "618" lleva directo a esa habitación.
 */
router.get('/search', asyncRoute((req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ query: q, exact: null, rooms: [], floors: [], movements: [] });

  const like = `%${q}%`;
  const exact = one(`${ROOM_SQL} WHERE r.number = @q`, { q });

  const rooms = decorate(all(`
    ${ROOM_SQL}
     WHERE r.number LIKE @like
        OR f.name LIKE @like
        OR s.name LIKE @like
        OR EXISTS (
             SELECT 1 FROM room_details rd
               JOIN fields fl ON fl.id = rd.field_id
               JOIN categories c ON c.id = fl.category_id
              WHERE rd.room_id = r.id
                AND (rd.value LIKE @like OR fl.label LIKE @like OR c.name LIKE @like)
           )
     ORDER BY CAST(r.number AS INTEGER) LIMIT 40`, { like }));

  const floors = all(`
    SELECT id, number, name FROM floors
     WHERE active = 1 AND (name LIKE @like OR CAST(number AS TEXT) = @q)
     ORDER BY sort_order`, { like, q });

  const movements = all(`
    SELECT * FROM movements
     WHERE room_number LIKE @like OR user_name LIKE @like OR department_name LIKE @like
        OR category_name LIKE @like OR action LIKE @like OR comment LIKE @like
        OR field_label LIKE @like OR new_value LIKE @like
     ORDER BY created_epoch DESC LIMIT 25`, { like });

  res.json({ query: q, exact: exact ? decorate([exact])[0] : null, rooms, floors, movements });
}));

// --------------------------------------------------------------- Listado
router.get('/', asyncRoute((req, res) => {
  const where = ['1 = 1']; const params = {};
  if (req.query.floorId)  { where.push('r.floor_id = @floorId');   params.floorId = int(req.query.floorId); }
  if (req.query.status)   { where.push('s.code = @status');         params.status = req.query.status; }
  if (req.query.active !== undefined) { where.push('r.active = @active'); params.active = req.query.active === 'false' ? 0 : 1; }
  else where.push('r.active = 1');

  const rooms = decorate(all(`${ROOM_SQL} WHERE ${where.join(' AND ')}
     ORDER BY f.sort_order, r.grid_col LIMIT 400`, params));
  res.json({ total: rooms.length, rooms });
}));

// ---------------------------------------------------- Detalle de habitación
router.get('/:id', asyncRoute((req, res) => {
  const room = getRoom(int(req.params.id));
  if (!room) return res.status(404).json({ error: 'Habitación no encontrada.' });

  const details = all(`
    SELECT rd.value, rd.updated_at, rd.last_movement_id,
           f.id AS field_id, f.code AS field_code, f.label, f.type, f.options,
           f.help_text, f.is_incident_when, f.sort_order,
           c.id AS category_id, c.code AS category_code, c.name AS category_name,
           c.icon AS category_icon, c.color AS category_color,
           c.department_id AS category_department_id, c.sort_order AS category_order,
           u.full_name AS updated_by_name
      FROM fields f
      JOIN categories c ON c.id = f.category_id
      LEFT JOIN room_details rd ON rd.field_id = f.id AND rd.room_id = @id
      LEFT JOIN users u ON u.id = rd.updated_by
     WHERE f.active = 1 AND c.active = 1
     ORDER BY c.sort_order, f.sort_order`, { id: room.id });

  const fields = getFieldMap();
  const categories = [];
  for (const d of details) {
    let cat = categories.find((c) => c.id === d.category_id);
    if (!cat) {
      cat = {
        id: d.category_id, code: d.category_code, name: d.category_name,
        icon: d.category_icon, color: d.category_color,
        departmentId: d.category_department_id,
        canEdit: req.user.permissions.includes('room.edit') && canWriteCategory(req.user, d.category_department_id),
        fields: [],
      };
      categories.push(cat);
    }
    const field = fields.byCode.get(d.field_code);
    cat.fields.push({
      fieldId: d.field_id, code: d.field_code, label: d.label, type: d.type,
      options: field?.optionList ?? [], helpText: d.help_text,
      value: d.value, updatedAt: d.updated_at, updatedBy: d.updated_by_name,
      isIncident: field ? isIncidentValue(field, d.value) : false,
      incidentValues: field?.incidentValues ?? [],
    });
  }

  const lastMovement = one(
    'SELECT * FROM movements WHERE room_id = @id ORDER BY created_epoch DESC, id DESC LIMIT 1', { id: room.id });
  const incidents = (openIncidentsByRoom().get(room.id) ?? []);
  const window = getSettingNumber('recurrence_window_days', 30);
  const recentIncidents = one(`
    SELECT COUNT(DISTINCT batch_id) AS n FROM movements
     WHERE room_id = @id AND is_incident = 1
       AND created_epoch >= @since`, { id: room.id, since: Date.now() - window * 86400000 }).n;

  res.json({
    room: decorate([room])[0],
    categories,
    lastMovement,
    openIncidents: incidents.map((i) => ({ field: i.field_label, value: i.value, category: i.category_name })),
    recurrence: { window, incidents: recentIncidents, thresholds: thresholds() },
    movementCount: one('SELECT COUNT(*) AS n FROM movements WHERE room_id = @id', { id: room.id }).n,
    canEditStatus: req.user.permissions.includes('room.status'),
    canCreateMovement: req.user.permissions.includes('movement.create'),
  });
}));

// ------------------------------------------- Historial (línea de tiempo)
router.get('/:id/history', requirePermission('history.view'), asyncRoute((req, res) => {
  const room = getRoom(int(req.params.id));
  if (!room) return res.status(404).json({ error: 'Habitación no encontrada.' });

  const where = ['m.room_id = @id']; const params = {
    id: room.id,
    limit: Math.min(Number(req.query.limit ?? 50), 500),
    offset: Number(req.query.offset ?? 0),
  };
  if (req.query.from)         { where.push('m.local_date >= @from');           params.from = req.query.from; }
  if (req.query.to)           { where.push('m.local_date <= @to');             params.to = req.query.to; }
  if (req.query.departmentId) { where.push('m.department_id = @departmentId'); params.departmentId = int(req.query.departmentId); }
  if (req.query.userId)       { where.push('m.user_id = @userId');             params.userId = int(req.query.userId); }
  if (req.query.categoryId)   { where.push('m.category_id = @categoryId');     params.categoryId = int(req.query.categoryId); }
  if (req.query.incidentsOnly === 'true') where.push('m.is_incident = 1');

  const sql = `FROM movements m WHERE ${where.join(' AND ')}`;
  const items = all(`SELECT m.* ${sql} ORDER BY m.created_epoch DESC, m.id DESC LIMIT @limit OFFSET @offset`, params);

  const photos = items.length
    ? all(`SELECT * FROM attachments WHERE movement_id IN (${items.map((m) => m.id).join(',')}) ORDER BY id`)
    : [];
  const byMovement = new Map();
  for (const p of photos) {
    if (!byMovement.has(p.movement_id)) byMovement.set(p.movement_id, []);
    byMovement.get(p.movement_id).push({
      id: p.id, kind: p.kind, url: `/api/photos/${p.id}`,
      originalName: p.original_name, user: p.user_name,
      date: p.local_date, time: p.local_time,
    });
  }

  res.json({
    room: { id: room.id, number: room.number, floor: room.floor_name },
    total: one(`SELECT COUNT(*) AS n ${sql}`, params).n,
    items: items.map((m) => ({ ...m, photos: byMovement.get(m.id) ?? [] })),
  });
}));

// ==================== REGISTRO: la operación transaccional ==================
// El usuario sólo elige categoría/acción, detalle y comentario.
// Fecha, hora, usuario, departamento y timestamp los pone el servidor.
router.post('/:id/movements',
  requirePermission('movement.create'),
  photoUpload.array('photos', 8),
  asyncRoute((req, res) => {
    const files = req.files ?? [];
    try {
      if (files.length && !req.user.permissions.includes('photo.upload')) {
        throw new MovementError('No tiene permiso para adjuntar fotografías.', 403);
      }
      let details = req.body.details ?? [];
      if (typeof details === 'string') {
        try { details = JSON.parse(details); } catch { throw new MovementError('El campo "details" no es JSON válido.', 400); }
      }
      let kinds = req.body.photoKinds ?? {};
      if (typeof kinds === 'string') { try { kinds = JSON.parse(kinds); } catch { kinds = {}; } }

      const result = recordMovement({
        roomId: int(req.params.id),
        user: req.user,
        req,
        movementTypeCode: req.body.movementType || null,
        statusCode: req.body.status || null,
        details: Array.isArray(details) ? details : [],
        comment: req.body.comment ?? null,
        photos: toPhotoRecords(files, kinds),
        correctsMovementId: int(req.body.correctsMovementId),
      });
      res.status(201).json(result);
    } catch (err) {
      // La transacción ya revirtió: los archivos subidos quedan huérfanos.
      discardFiles(files);
      throw err;
    }
  }));

/** Acciones rápidas disponibles para el usuario actual. */
router.get('/meta/quick-actions', asyncRoute((req, res) => {
  const rows = all(`
    SELECT mt.code, mt.name, mt.icon, mt.severity, mt.requires_comment, mt.requires_photo,
           mt.allows_photo, mt.is_incident, mt.is_quick_action, mt.sort_order,
           c.id AS category_id, c.code AS category_code, c.name AS category_name,
           c.department_id AS category_department_id,
           s.code AS target_status_code, s.name AS target_status_name
      FROM movement_types mt
      LEFT JOIN categories c ON c.id = mt.category_id
      LEFT JOIN room_statuses s ON s.id = mt.target_status_id
     WHERE mt.active = 1 AND mt.is_system = 0
     ORDER BY mt.sort_order`);
  res.json({
    actions: rows
      .filter((a) => canWriteCategory(req.user, a.category_department_id))
      .filter((a) => !a.target_status_code || req.user.permissions.includes('room.status'))
      .map((a) => ({ ...a, requiresComment: !!a.requires_comment, requiresPhoto: !!a.requires_photo })),
  });
}));

export default router;
