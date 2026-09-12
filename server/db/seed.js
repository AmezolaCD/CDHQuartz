import bcrypt from 'bcryptjs';
import { db, migrate, insert, one, transaction } from '../lib/db.js';
import { esEjecutadoDirectamente } from '../lib/cli.js';
import { stamp, setTimezone } from '../lib/time.js';
import {
  DEPARTMENTS, PERMISSIONS, ROLES, ROOM_STATUSES, ROOM_TYPES,
  CATEGORIES, MOVEMENT_TYPES, FLOOR_MAP, SETTINGS,
} from './catalog.js';

const SEED_PASSWORD = process.env.CDH_SEED_PASSWORD || 'Quartz#2026';

const SEED_USERS = [
  { username:'admin',       full_name:'Administrador CDH',      role:'ADMIN',      dept:'SISTEMAS_TI' },
  { username:'gerencia',    full_name:'Gerencia Hotel Quartz',  role:'GERENCIA',   dept:'GERENCIA' },
  { username:'supervisor',  full_name:'Supervisor de Piso',     role:'SUPERVISOR', dept:'SUPERVISION' },
  { username:'amadellaves', full_name:'Jefa de Ama de Llaves',  role:'AMA',        dept:'AMA' },
  { username:'mantenimiento', full_name:'Jefe de Mantenimiento',role:'MTTO',       dept:'MTTO' },
  // Usuario maestro: acceso completo. Conserva el departamento Sistemas para
  // que sus movimientos se sigan atribuyendo a esa área en el historial.
  { username:'sistemas',    full_name:'Encargado de Sistemas',  role:'ADMIN',      dept:'SIS' },
  { username:'recepcion',   full_name:'Recepción Turno A',      role:'RECEPCION',  dept:'RECEPCION' },
];

export function seed({ quiet = false } = {}) {
  migrate();
  const log = quiet ? () => {} : (...a) => console.log(...a);

  if (one('SELECT COUNT(*) AS n FROM rooms').n > 0) {
    log('[seed] La base ya contiene habitaciones. Nada que hacer.');
    return { skipped: true };
  }

  const t = stamp();
  const summary = transaction(() => {
    // ------------------------------------------------------------ Catálogos
    const dept = {};
    for (const d of DEPARTMENTS) dept[d.code] = insert('departments', d);

    const perm = {};
    for (const p of PERMISSIONS) perm[p.code] = insert('permissions', p);

    const role = {};
    for (const r of ROLES) {
      const { permissions, ...row } = r;
      role[r.code] = insert('roles', row);
      for (const code of permissions) {
        insert('role_permissions', { role_id: role[r.code], permission_id: perm[code] });
      }
    }

    const status = {};
    ROOM_STATUSES.forEach((s, i) => {
      const { clean_status, ...row } = s;
      status[s.code] = insert('room_statuses', { ...row, sort_order: i + 1, is_system: 1 });
    });
    // El estado al que lleva la limpieza se enlaza después: apunta a otro
    // estado de la misma tabla, que puede no existir todavía en la vuelta.
    for (const s of ROOM_STATUSES) {
      if (!s.clean_status) continue;
      db.prepare('UPDATE room_statuses SET clean_status_id = @destino WHERE id = @id')
        .run({ destino: status[s.clean_status], id: status[s.code] });
    }

    const rtype = {};
    for (const rt of ROOM_TYPES) rtype[rt.code] = insert('room_types', rt);

    const cat = {}; const field = {};
    for (const c of CATEGORIES) {
      const { fields, department, pending_status, ...row } = c;
      cat[c.code] = insert('categories', {
        ...row,
        department_id: department ? dept[department] : null,
        pending_status_id: pending_status ? status[pending_status] : null,
      });
      fields.forEach((f, i) => {
        field[f.code] = insert('fields', {
          category_id: cat[c.code],
          code: f.code,
          label: f.label,
          type: f.type,
          options: f.options ? JSON.stringify(f.options) : null,
          default_value: f.default_value ?? null,
          is_incident_when: f.is_incident_when ? JSON.stringify(f.is_incident_when) : null,
          sort_order: i + 1,
        });
      });
    }

    for (const m of MOVEMENT_TYPES) {
      const { category, target_status, ...row } = m;
      insert('movement_types', {
        ...row,
        category_id: category ? cat[category] : null,
        target_status_id: target_status ? status[target_status] : null,
      });
    }

    for (const s of SETTINGS) insert('settings', { ...s, updated_at: t.iso });

    // -------------------------------------------------------------- Usuarios
    const hash = bcrypt.hashSync(SEED_PASSWORD, 10);
    const users = {};
    for (const u of SEED_USERS) {
      users[u.username] = insert('users', {
        username: u.username,
        full_name: u.full_name,
        email: `${u.username}@hotelquartz.local`,
        password_hash: hash,
        role_id: role[u.role],
        department_id: dept[u.dept],
        must_change_password: 1,
        created_at: t.iso,
      });
    }

    // -------------------------- Pisos y habitaciones (distribución real) ----
    const defaultStatus = status.DISPONIBLE_LIMPIO;
    const fieldRows = db.prepare('SELECT id, default_value FROM fields').all();
    let roomCount = 0;

    FLOOR_MAP.forEach((f, idx) => {
      const floorId = insert('floors', {
        number: f.number, name: f.name, sort_order: idx + 1, created_at: t.iso,
      });
      f.rooms.forEach((num, col) => {
        if (num === null) return; // espacio sin habitación: permanece vacío
        const roomId = insert('rooms', {
          number: String(num),
          floor_id: floorId,
          room_type_id: null,
          status_id: defaultStatus,
          grid_row: f.number,
          grid_col: col + 1,
          status_changed_at: t.iso,
          updated_at: t.iso,
          created_at: t.iso,
        });
        for (const fr of fieldRows) {
          insert('room_details', {
            room_id: roomId, field_id: fr.id, value: fr.default_value ?? null,
          });
        }
        roomCount += 1;
      });
    });

    insert('audit_log', {
      entity_type: 'system', entity_id: 'seed', entity_label: 'Carga inicial',
      action: 'seed', actor_name: 'sistema',
      after_json: JSON.stringify({ floors: FLOOR_MAP.length, rooms: roomCount }),
      reason: 'Carga inicial del catálogo y la distribución real de habitaciones.',
      created_at: t.iso, created_epoch: t.epoch, local_date: t.localDate, local_time: t.localTime,
    });

    return { floors: FLOOR_MAP.length, rooms: roomCount, users: SEED_USERS.length };
  })();

  const target = Number(one("SELECT value FROM settings WHERE key='target_room_count'").value);
  log(`[seed] Pisos: ${summary.floors}`);
  log(`[seed] Habitaciones cargadas: ${summary.rooms} de ${target} (faltan ${target - summary.rooms}, se dan de alta en Administración > Catálogo de habitaciones)`);
  log(`[seed] Usuarios: ${summary.users} — contraseña inicial: ${SEED_PASSWORD}`);
  return summary;
}

if (esEjecutadoDirectamente(import.meta.url)) {
  setTimezone(process.env.CDH_TZ || 'America/Tijuana');
  seed();
}
