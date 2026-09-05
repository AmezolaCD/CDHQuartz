import express from 'express';
import { db, all, one, insert, update, transaction } from '../lib/db.js';
import { requireAuth, requirePermission, asyncRoute } from '../middleware/auth.js';
import { audit, diff } from '../lib/audit.js';
import { hashPassword, revokeAllSessions, permissionsOf } from '../lib/auth.js';
import { allSettings, setSettingValue, loadSettings, settingRow } from '../lib/settings.js';
import { GRID_COLUMNS } from '../db/catalog.js';

const router = express.Router();
router.use(requireAuth);

const int = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

class AdminError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * CRUD auditado para tablas de catálogo.
 * Nada se elimina físicamente: se desactiva (active = 0).
 */
function catalogResource(path, {
  table, entityType, label, permission, columns, order = 'sort_order',
  labelOf = (r) => r.name, validate = null, extraSelect = '',
}) {
  const pick = (body) => {
    const out = {};
    for (const [key, kind] of Object.entries(columns)) {
      if (body[key] === undefined) continue;
      out[key] = kind === 'bool' ? bool(body[key])
        : kind === 'int' ? int(body[key])
        : kind === 'json' ? (body[key] === null ? null : JSON.stringify(body[key]))
        : body[key];
    }
    return out;
  };

  router.get(`/${path}`, requirePermission(permission), asyncRoute((req, res) => {
    res.json({ items: all(`SELECT t.* ${extraSelect} FROM ${table} t ORDER BY ${order}`) });
  }));

  router.post(`/${path}`, requirePermission(permission), asyncRoute((req, res) => {
    const data = pick(req.body ?? {});
    if (validate) validate(data, null);
    const result = transaction(() => {
      const id = insert(table, data);
      const row = one(`SELECT * FROM ${table} WHERE id = @id`, { id });
      audit({
        entityType, entityId: id, entityLabel: labelOf(row), action: 'create',
        actor: req.user, after: row, reason: req.body?.reason ?? `Alta de ${label}.`, req,
      });
      return row;
    })();
    res.status(201).json({ item: result });
  }));

  router.put(`/${path}/:id`, requirePermission(permission), asyncRoute((req, res) => {
    const id = int(req.params.id);
    const before = one(`SELECT * FROM ${table} WHERE id = @id`, { id });
    if (!before) return res.status(404).json({ error: `${label} no encontrado.` });
    const data = pick(req.body ?? {});
    if (validate) validate(data, before);
    const result = transaction(() => {
      update(table, id, data);
      const after = one(`SELECT * FROM ${table} WHERE id = @id`, { id });
      const d = diff(before, after, Object.keys(data));
      if (d) {
        audit({
          entityType, entityId: id, entityLabel: labelOf(after), action: 'update',
          actor: req.user, before: d.before, after: d.after,
          reason: req.body?.reason ?? `Modificación de ${label}.`, req,
        });
      }
      return after;
    })();
    res.json({ item: result });
  }));

  // Baja lógica: conserva el historial.
  router.delete(`/${path}/:id`, requirePermission(permission), asyncRoute((req, res) => {
    const id = int(req.params.id);
    const before = one(`SELECT * FROM ${table} WHERE id = @id`, { id });
    if (!before) return res.status(404).json({ error: `${label} no encontrado.` });
    if (before.is_system) return res.status(409).json({ error: `${label} del sistema: no se puede desactivar.` });
    const result = transaction(() => {
      update(table, id, { active: 0 });
      const after = one(`SELECT * FROM ${table} WHERE id = @id`, { id });
      audit({
        entityType, entityId: id, entityLabel: labelOf(after), action: 'deactivate',
        actor: req.user, before: { active: 1 }, after: { active: 0 },
        reason: req.body?.reason ?? `Baja lógica de ${label}. El historial se conserva.`, req,
      });
      return after;
    })();
    res.json({ item: result });
  }));
}

// ------------------------------------------------------------- Catálogos
catalogResource('departments', {
  table: 'departments', entityType: 'department', label: 'departamento', permission: 'admin.catalog',
  columns: { code: 'text', name: 'text', color: 'text', sort_order: 'int', active: 'bool' },
});

catalogResource('floors', {
  table: 'floors', entityType: 'floor', label: 'piso', permission: 'admin.rooms',
  columns: { number: 'int', name: 'text', sort_order: 'int', active: 'bool' },
});

catalogResource('room-types', {
  table: 'room_types', entityType: 'room_type', label: 'tipo de habitación', permission: 'admin.rooms',
  columns: { code: 'text', name: 'text', description: 'text', sort_order: 'int', active: 'bool' },
});

catalogResource('statuses', {
  table: 'room_statuses', entityType: 'room_status', label: 'estado', permission: 'admin.catalog',
  columns: {
    code: 'text', name: 'text', icon: 'text', color: 'text', description: 'text',
    counts_ready: 'bool', counts_cleaning: 'bool', counts_maintenance: 'bool',
    counts_blocked: 'bool', counts_attention: 'bool', counts_pending: 'bool',
    sort_order: 'int', active: 'bool',
  },
});

catalogResource('categories', {
  table: 'categories', entityType: 'category', label: 'categoría', permission: 'admin.catalog',
  columns: { code: 'text', name: 'text', department_id: 'int', icon: 'text', color: 'text', sort_order: 'int', active: 'bool' },
});

catalogResource('fields', {
  table: 'fields', entityType: 'field', label: 'campo', permission: 'admin.catalog',
  order: 'category_id, sort_order', labelOf: (r) => r.label,
  extraSelect: ', (SELECT c.name FROM categories c WHERE c.id = t.category_id) AS category_name',
  columns: {
    category_id: 'int', code: 'text', label: 'text', type: 'text',
    options: 'json', default_value: 'text', help_text: 'text',
    is_incident_when: 'json', sort_order: 'int', active: 'bool',
  },
  validate: (data) => {
    if (data.type && !['select', 'text', 'textarea', 'boolean', 'number', 'date'].includes(data.type)) {
      throw new AdminError(`Tipo de campo no soportado: ${data.type}`);
    }
  },
});

catalogResource('movement-types', {
  table: 'movement_types', entityType: 'movement_type', label: 'tipo de movimiento', permission: 'admin.catalog',
  columns: {
    code: 'text', name: 'text', category_id: 'int', target_status_id: 'int', icon: 'text',
    severity: 'text', is_incident: 'bool', closes_incident: 'bool', requires_comment: 'bool',
    requires_photo: 'bool', allows_photo: 'bool', is_quick_action: 'bool',
    cross_department: 'bool', notify: 'bool',
    sort_order: 'int', active: 'bool',
  },
});

// ------------------------------------------------------------ Habitaciones
router.get('/rooms', requirePermission('admin.rooms'), asyncRoute((req, res) => {
  res.json({
    gridColumns: GRID_COLUMNS,
    items: all(`
      SELECT r.*, f.number AS floor_number, f.name AS floor_name,
             s.code AS status_code, s.name AS status_name,
             t.name AS type_name,
             (SELECT COUNT(*) FROM movements m WHERE m.room_id = r.id) AS movements
        FROM rooms r
        JOIN floors f ON f.id = r.floor_id
        JOIN room_statuses s ON s.id = r.status_id
        LEFT JOIN room_types t ON t.id = r.room_type_id
       ORDER BY f.sort_order, r.grid_col`),
  });
}));

function validateRoomSlot({ floorId, gridRow, gridCol, roomId = null }) {
  const clash = one(
    `SELECT r.id, r.number FROM rooms r
      WHERE r.grid_row = @gridRow AND r.grid_col = @gridCol AND (@roomId IS NULL OR r.id <> @roomId)`,
    { gridRow, gridCol, roomId });
  if (clash) throw new AdminError(`La posición fila ${gridRow} / columna ${gridCol} ya la ocupa la habitación ${clash.number}.`, 409);
  if (gridCol < 1 || gridCol > GRID_COLUMNS) {
    throw new AdminError(`La columna debe estar entre 1 y ${GRID_COLUMNS}.`);
  }
}

router.post('/rooms', requirePermission('admin.rooms'), asyncRoute((req, res) => {
  const b = req.body ?? {};
  const number = String(b.number ?? '').trim();
  if (!number) throw new AdminError('El número de habitación es obligatorio.');
  if (one('SELECT id FROM rooms WHERE number = @n', { n: number })) {
    throw new AdminError(`La habitación ${number} ya existe.`, 409);
  }
  const floor = one('SELECT * FROM floors WHERE id = @id', { id: int(b.floorId) });
  if (!floor) throw new AdminError('Piso no encontrado.', 404);

  const status = one('SELECT * FROM room_statuses WHERE code = @c AND active = 1',
    { c: b.statusCode ?? 'DISPONIBLE' });
  if (!status) throw new AdminError('Estado inicial no válido.');

  const gridRow = int(b.gridRow) ?? floor.number;
  const gridCol = int(b.gridCol) ?? ((one(
    'SELECT MAX(grid_col) AS m FROM rooms WHERE grid_row = @r', { r: gridRow })?.m ?? 0) + 1);
  validateRoomSlot({ floorId: floor.id, gridRow, gridCol });

  const item = transaction(() => {
    const now = new Date().toISOString();
    const id = insert('rooms', {
      number, floor_id: floor.id, room_type_id: int(b.roomTypeId),
      status_id: status.id, grid_row: gridRow, grid_col: gridCol,
      notes: b.notes ?? null, active: 1, status_changed_at: now, updated_at: now,
      updated_by: req.user.id, created_at: now,
    });
    // Se siembran los valores por defecto de todos los campos activos.
    for (const f of all('SELECT id, default_value FROM fields WHERE active = 1')) {
      insert('room_details', { room_id: id, field_id: f.id, value: f.default_value ?? null });
    }
    const row = one('SELECT * FROM rooms WHERE id = @id', { id });
    audit({
      entityType: 'room', entityId: id, entityLabel: `Habitación ${number}`, action: 'create',
      actor: req.user, after: row, roomId: id,
      reason: req.body?.reason ?? 'Alta de habitación desde el catálogo.', req,
    });
    return row;
  })();
  res.status(201).json({ item });
}));

router.put('/rooms/:id', requirePermission('admin.rooms'), asyncRoute((req, res) => {
  const id = int(req.params.id);
  const before = one('SELECT * FROM rooms WHERE id = @id', { id });
  if (!before) return res.status(404).json({ error: 'Habitación no encontrada.' });
  const b = req.body ?? {};

  const data = {};
  if (b.number !== undefined) {
    const n = String(b.number).trim();
    const clash = one('SELECT id FROM rooms WHERE number = @n AND id <> @id', { n, id });
    if (clash) throw new AdminError(`La habitación ${n} ya existe.`, 409);
    data.number = n;
  }
  if (b.floorId !== undefined)    data.floor_id = int(b.floorId);
  if (b.roomTypeId !== undefined) data.room_type_id = int(b.roomTypeId);
  if (b.notes !== undefined)      data.notes = b.notes;
  if (b.active !== undefined)     data.active = bool(b.active);
  if (b.gridRow !== undefined || b.gridCol !== undefined) {
    const gridRow = int(b.gridRow) ?? before.grid_row;
    const gridCol = int(b.gridCol) ?? before.grid_col;
    validateRoomSlot({ floorId: data.floor_id ?? before.floor_id, gridRow, gridCol, roomId: id });
    data.grid_row = gridRow; data.grid_col = gridCol;
  }
  data.updated_at = new Date().toISOString();
  data.updated_by = req.user.id;

  const item = transaction(() => {
    update('rooms', id, data);
    const after = one('SELECT * FROM rooms WHERE id = @id', { id });
    const d = diff(before, after, Object.keys(data).filter((k) => !['updated_at', 'updated_by'].includes(k)));
    if (d) {
      audit({
        entityType: 'room', entityId: id, entityLabel: `Habitación ${after.number}`,
        action: before.active && !after.active ? 'deactivate' : 'update',
        actor: req.user, before: d.before, after: d.after, roomId: id,
        reason: b.reason ?? (before.active && !after.active
          ? 'Habitación desactivada. El historial se conserva íntegro.'
          : 'Modificación de habitación.'),
        req,
      });
    }
    return after;
  })();
  res.json({ item });
}));

// ------------------------------------------------------ Usuarios y permisos
router.get('/users', requirePermission('admin.users'), asyncRoute((req, res) => {
  res.json({
    items: all(`
      SELECT u.id, u.username, u.full_name, u.email, u.phone, u.active,
             u.must_change_password, u.last_login_at, u.created_at,
             r.id AS role_id, r.code AS role_code, r.name AS role_name,
             d.id AS department_id, d.name AS department_name,
             (SELECT COUNT(*) FROM movements m WHERE m.user_id = u.id) AS movements
        FROM users u
        JOIN roles r ON r.id = u.role_id
        LEFT JOIN departments d ON d.id = u.department_id
       ORDER BY u.active DESC, u.full_name`),
  });
}));

router.post('/users', requirePermission('admin.users'), asyncRoute((req, res) => {
  const b = req.body ?? {};
  const username = String(b.username ?? '').trim().toLowerCase();
  if (!username || !b.fullName) throw new AdminError('Usuario y nombre completo son obligatorios.');
  if (!b.password || String(b.password).length < 8) throw new AdminError('La contraseña debe tener al menos 8 caracteres.');
  if (one('SELECT id FROM users WHERE lower(username) = @u', { u: username })) {
    throw new AdminError(`El usuario "${username}" ya existe.`, 409);
  }
  if (!one('SELECT id FROM roles WHERE id = @id AND active = 1', { id: int(b.roleId) })) {
    throw new AdminError('Rol no válido.');
  }

  const item = transaction(() => {
    const id = insert('users', {
      username, full_name: b.fullName, email: b.email ?? null, phone: b.phone ?? null,
      password_hash: hashPassword(String(b.password)),
      role_id: int(b.roleId), department_id: int(b.departmentId),
      must_change_password: bool(b.mustChangePassword ?? true),
      active: 1, created_at: new Date().toISOString(),
    });
    const row = one('SELECT id, username, full_name, email, role_id, department_id, active FROM users WHERE id = @id', { id });
    audit({
      entityType: 'user', entityId: id, entityLabel: username, action: 'create',
      actor: req.user, after: row, reason: b.reason ?? 'Alta de usuario.', req,
    });
    return row;
  })();
  res.status(201).json({ item });
}));

router.put('/users/:id', requirePermission('admin.users'), asyncRoute((req, res) => {
  const id = int(req.params.id);
  const before = one(`
    SELECT id, username, full_name, email, phone, role_id, department_id, active, must_change_password
      FROM users WHERE id = @id`, { id });
  if (!before) return res.status(404).json({ error: 'Usuario no encontrado.' });
  const b = req.body ?? {};

  const data = {};
  if (b.fullName !== undefined)     data.full_name = b.fullName;
  if (b.email !== undefined)        data.email = b.email;
  if (b.phone !== undefined)        data.phone = b.phone;
  if (b.roleId !== undefined)       data.role_id = int(b.roleId);
  if (b.departmentId !== undefined) data.department_id = int(b.departmentId);
  if (b.active !== undefined)       data.active = bool(b.active);
  if (b.password) {
    if (String(b.password).length < 8) throw new AdminError('La contraseña debe tener al menos 8 caracteres.');
    data.password_hash = hashPassword(String(b.password));
    data.must_change_password = bool(b.mustChangePassword ?? true);
  }
  if (id === req.user.id && b.active !== undefined && !bool(b.active)) {
    throw new AdminError('No puede desactivar su propio usuario.', 409);
  }
  data.updated_at = new Date().toISOString();

  const item = transaction(() => {
    update('users', id, data);
    const after = one(`
      SELECT id, username, full_name, email, phone, role_id, department_id, active, must_change_password
        FROM users WHERE id = @id`, { id });
    const keys = Object.keys(data).filter((k) => !['updated_at', 'password_hash'].includes(k));
    const d = diff(before, after, keys);
    const changedPassword = !!data.password_hash;
    if (d || changedPassword) {
      audit({
        entityType: 'user', entityId: id, entityLabel: after.username,
        action: before.role_id !== after.role_id ? 'permission_change'
          : (before.active && !after.active) ? 'deactivate' : 'update',
        actor: req.user,
        before: { ...(d?.before ?? {}), ...(changedPassword ? { password: '***' } : {}) },
        after: { ...(d?.after ?? {}), ...(changedPassword ? { password: '*** (restablecida)' } : {}) },
        reason: b.reason ?? 'Modificación de usuario.', req,
      });
    }
    // Un cambio de rol, contraseña o baja invalida las sesiones abiertas.
    if (changedPassword || before.role_id !== after.role_id || (before.active && !after.active)) {
      revokeAllSessions(id, 'Cambio de credenciales, rol o estado del usuario.', req.user, req);
    }
    return after;
  })();
  res.json({ item });
}));

router.get('/roles', requirePermission('admin.users'), asyncRoute((req, res) => {
  const roles = all('SELECT * FROM roles ORDER BY id');
  res.json({
    roles: roles.map((r) => ({ ...r, permissions: permissionsOf(r.id) })),
    permissions: all('SELECT * FROM permissions ORDER BY grp, code'),
  });
}));

router.put('/roles/:id/permissions', requirePermission('admin.users'), asyncRoute((req, res) => {
  const id = int(req.params.id);
  const role = one('SELECT * FROM roles WHERE id = @id', { id });
  if (!role) return res.status(404).json({ error: 'Rol no encontrado.' });
  const codes = Array.isArray(req.body?.permissions) ? req.body.permissions : null;
  if (!codes) throw new AdminError('Se espera un arreglo "permissions" con los códigos.');
  if (role.code === 'ADMIN') throw new AdminError('El rol Administrador conserva siempre todos los permisos.', 409);

  const result = transaction(() => {
    const before = permissionsOf(id);
    db.prepare('DELETE FROM role_permissions WHERE role_id = @id').run({ id });
    for (const code of codes) {
      const p = one('SELECT id FROM permissions WHERE code = @c', { c: code });
      if (!p) throw new AdminError(`Permiso desconocido: ${code}`);
      insert('role_permissions', { role_id: id, permission_id: p.id });
    }
    const after = permissionsOf(id);
    audit({
      entityType: 'role', entityId: id, entityLabel: role.name, action: 'permission_change',
      actor: req.user, before: { permisos: before }, after: { permisos: after },
      reason: req.body?.reason ?? 'Actualización de permisos del rol.', req,
    });
    // Los usuarios del rol deben reautenticarse con los nuevos permisos.
    for (const u of all('SELECT id FROM users WHERE role_id = @id AND active = 1', { id })) {
      revokeAllSessions(u.id, 'Cambio de permisos del rol.', req.user, req);
    }
    return after;
  })();
  res.json({ permissions: result });
}));

router.put('/roles/:id', requirePermission('admin.users'), asyncRoute((req, res) => {
  const id = int(req.params.id);
  const before = one('SELECT * FROM roles WHERE id = @id', { id });
  if (!before) return res.status(404).json({ error: 'Rol no encontrado.' });
  const b = req.body ?? {};
  const data = {};
  if (b.name !== undefined)             data.name = b.name;
  if (b.description !== undefined)      data.description = b.description;
  if (b.departmentScope !== undefined)  data.department_scope = bool(b.departmentScope);
  if (b.active !== undefined && !before.is_system) data.active = bool(b.active);

  const item = transaction(() => {
    update('roles', id, data);
    const after = one('SELECT * FROM roles WHERE id = @id', { id });
    const d = diff(before, after, Object.keys(data));
    if (d) {
      audit({ entityType: 'role', entityId: id, entityLabel: after.name, action: 'update',
        actor: req.user, before: d.before, after: d.after, reason: b.reason ?? 'Modificación de rol.', req });
    }
    return after;
  })();
  res.json({ item });
}));

// ------------------------------------------------------------ Configuración
router.get('/settings', requirePermission('admin.settings'), asyncRoute((req, res) => {
  res.json({ items: allSettings() });
}));

router.put('/settings/:key', requirePermission('admin.settings'), asyncRoute((req, res) => {
  const key = req.params.key;
  const before = settingRow(key);
  if (!before) return res.status(404).json({ error: 'Configuración no encontrada.' });
  const value = String(req.body?.value ?? '');

  if (key === 'timezone') {
    try { new Intl.DateTimeFormat('es-MX', { timeZone: value }).format(new Date()); }
    catch { throw new AdminError(`Zona horaria inválida: ${value}`); }
  }
  if (before.type === 'number' && !Number.isFinite(Number(value))) {
    throw new AdminError(`"${before.label}" debe ser un número.`);
  }

  transaction(() => {
    setSettingValue(key, value, req.user.id);
    audit({
      entityType: 'setting', entityId: key, entityLabel: before.label, action: 'update',
      actor: req.user, before: { [key]: before.value }, after: { [key]: value },
      reason: req.body?.reason ?? 'Cambio de configuración.', req,
    });
  })();
  loadSettings();
  res.json({ item: settingRow(key) });
}));

router.use((err, req, res, next) => {
  if (err instanceof AdminError) return res.status(err.status).json({ error: err.message });
  next(err);
});

export default router;
