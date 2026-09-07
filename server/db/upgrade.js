// ============================================================================
// npm run upgrade — pone al día una base EN USO con el catálogo del código.
//
// Regla de oro: sólo AÑADE lo que falta. Nunca sobrescribe ni elimina, para
// no pisar lo que un administrador haya configurado desde la aplicación ni
// tocar el historial, que es inmutable.
//
//   npm run upgrade                          aplica los faltantes
//   npm run upgrade -- --dry-run             muestra el plan sin escribir
//   npm run upgrade -- --timezone=America/Tijuana
//   npm run upgrade -- --promote=sistemas    da rol Administrador (recuperación)
// ============================================================================
import { db, migrate, one, all, insert, transaction } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { esEjecutadoDirectamente } from '../lib/cli.js';
import { loadSettings, setSettingValue } from '../lib/settings.js';
import {
  DEPARTMENTS, PERMISSIONS, ROLES, ROOM_STATUSES, ROOM_TYPES,
  CATEGORIES, MOVEMENT_TYPES, SETTINGS,
} from './catalog.js';

function parseArgs(argv) {
  const opts = { dryRun: false, timezone: null, promote: null };
  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a.startsWith('--timezone=')) opts.timezone = a.slice(11).trim();
    else if (a.startsWith('--promote=')) opts.promote = a.slice(10).trim().toLowerCase();
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Opción desconocida: ${a}`);
  }
  return opts;
}

const HELP = `
CDH — puesta al día del catálogo sobre una base en uso.

  npm run upgrade                        Añade lo que falte (no sobrescribe nada)
  npm run upgrade -- --dry-run           Muestra el plan sin escribir
  npm run upgrade -- --timezone=<zona>   Cambia la zona horaria del hotel
  npm run upgrade -- --promote=<usuario> Le da el rol Administrador

Todo cambio queda en la bitácora de auditoría. El historial de movimientos
nunca se modifica.
`;

/** Ejecuta la puesta al día. Devuelve la lista de acciones (aplicadas o previstas). */
export function upgrade({ dryRun = false, timezone = null, promote = null, quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  migrate();
  loadSettings();

  const acciones = [];
  const anotar = (grupo, detalle) => acciones.push({ grupo, detalle });

  const aplicar = transaction(() => {
    const idPor = (tabla, code) => one(`SELECT id FROM ${tabla} WHERE code = @code`, { code })?.id ?? null;

    // ------------------------------------------------------- Departamentos
    for (const d of DEPARTMENTS) {
      if (!idPor('departments', d.code)) { insert('departments', d); anotar('Departamento', d.name); }
    }

    // ---------------------------------------------------------- Permisos
    for (const p of PERMISSIONS) {
      if (!idPor('permissions', p.code)) { insert('permissions', p); anotar('Permiso', `${p.name} (${p.code})`); }
    }

    // ------------------------------------------------------------- Roles
    for (const r of ROLES) {
      const { permissions, ...fila } = r;
      if (!idPor('roles', r.code)) {
        const id = insert('roles', fila);
        for (const code of permissions) {
          const pid = idPor('permissions', code);
          if (pid) insert('role_permissions', { role_id: id, permission_id: pid });
        }
        anotar('Rol', r.name);
      }
    }
    // Invariante del sistema: el rol Administrador conserva SIEMPRE todos los
    // permisos; la propia pantalla de administración lo impide editar.
    const adminId = idPor('roles', 'ADMIN');
    if (adminId) {
      for (const p of all('SELECT id, code, name FROM permissions')) {
        const tiene = one(
          'SELECT 1 x FROM role_permissions WHERE role_id = @r AND permission_id = @p',
          { r: adminId, p: p.id });
        if (!tiene) {
          insert('role_permissions', { role_id: adminId, permission_id: p.id });
          anotar('Permiso al rol Administrador', p.name);
        }
      }
    }

    // ----------------------------------------------------------- Estados
    ROOM_STATUSES.forEach((s, i) => {
      if (!idPor('room_statuses', s.code)) {
        insert('room_statuses', { ...s, sort_order: i + 1, is_system: 1 });
        anotar('Estado', s.name);
      }
    });

    // -------------------------------------------------- Tipos de habitación
    for (const t of ROOM_TYPES) {
      if (!idPor('room_types', t.code)) { insert('room_types', t); anotar('Tipo de habitación', t.name); }
    }

    // -------------------------------------------------- Categorías y campos
    for (const c of CATEGORIES) {
      const { fields, department, pending_status, ...fila } = c;
      let catId = idPor('categories', c.code);
      if (!catId) {
        catId = insert('categories', {
          ...fila,
          department_id: department ? idPor('departments', department) : null,
          pending_status_id: pending_status ? idPor('room_statuses', pending_status) : null,
        });
        anotar('Categoría', c.name);
      }
      fields.forEach((f, i) => {
        if (idPor('fields', f.code)) return;
        insert('fields', {
          category_id: catId, code: f.code, label: f.label, type: f.type,
          options: f.options ? JSON.stringify(f.options) : null,
          default_value: f.default_value ?? null,
          is_incident_when: f.is_incident_when ? JSON.stringify(f.is_incident_when) : null,
          sort_order: i + 1,
        });
        anotar('Campo', `${c.name} › ${f.label}`);
      });
    }

    // ------------------------------------------------ Tipos de movimiento
    for (const m of MOVEMENT_TYPES) {
      if (idPor('movement_types', m.code)) continue;
      const { category, target_status, ...fila } = m;
      insert('movement_types', {
        ...fila,
        category_id: category ? idPor('categories', category) : null,
        target_status_id: target_status ? idPor('room_statuses', target_status) : null,
      });
      anotar('Acción', m.name);
    }

    // ---------------------------------------------------- Configuraciones
    // Sólo se añaden claves nuevas: el valor de una clave existente es una
    // decisión del administrador y no se toca (use --timezone si procede).
    for (const s of SETTINGS) {
      if (!one('SELECT 1 x FROM settings WHERE key = @key', { key: s.key })) {
        insert('settings', { ...s, updated_at: new Date().toISOString() });
        anotar('Configuración', `${s.label} = ${s.value}`);
      }
    }

    // --------------------------- Relleno de detalles en habitaciones vivas
    // Un campo nuevo debe existir en todas las habitaciones ya dadas de alta.
    const faltantes = all(`
      SELECT r.id AS room_id, r.number, f.id AS field_id, f.label, f.default_value
        FROM rooms r
        CROSS JOIN fields f
       WHERE f.active = 1
         AND NOT EXISTS (
           SELECT 1 FROM room_details rd
            WHERE rd.room_id = r.id AND rd.field_id = f.id)`);
    for (const x of faltantes) {
      insert('room_details', { room_id: x.room_id, field_id: x.field_id, value: x.default_value ?? null });
    }
    if (faltantes.length) {
      const campos = [...new Set(faltantes.map((x) => x.label))];
      anotar('Detalles sembrados',
        `${faltantes.length} valores en habitaciones existentes (${campos.join(', ')})`);
    }

    // ------------------------------------------------- Opciones explícitas
    if (timezone) {
      try { new Intl.DateTimeFormat('es-MX', { timeZone: timezone }).format(new Date()); }
      catch { throw new Error(`Zona horaria inválida: ${timezone}`); }
      const antes = one("SELECT value FROM settings WHERE key = 'timezone'")?.value ?? null;
      if (antes !== timezone) {
        setSettingValue('timezone', timezone, null);
        audit({
          entityType: 'setting', entityId: 'timezone', entityLabel: 'Zona horaria del hotel',
          action: 'update', before: { timezone: antes }, after: { timezone },
          reason: 'Puesta al día ejecutada desde npm run upgrade.',
        });
        anotar('Zona horaria', `${antes ?? 'sin definir'} → ${timezone}`);
      }
    }

    if (promote) {
      const u = one('SELECT id, username, role_id FROM users WHERE lower(username) = @u', { u: promote });
      if (!u) throw new Error(`No existe el usuario "${promote}".`);
      if (!adminId) throw new Error('No existe el rol Administrador.');
      if (u.role_id !== adminId) {
        const antes = one('SELECT name FROM roles WHERE id = @id', { id: u.role_id })?.name ?? null;
        db.prepare('UPDATE users SET role_id = @r, updated_at = @now WHERE id = @id')
          .run({ r: adminId, id: u.id, now: new Date().toISOString() });
        // Las sesiones abiertas deben reautenticarse con los permisos nuevos.
        db.prepare('UPDATE sessions SET revoked_at = @now WHERE user_id = @u AND revoked_at IS NULL')
          .run({ now: new Date().toISOString(), u: u.id });
        audit({
          entityType: 'user', entityId: u.id, entityLabel: u.username, action: 'permission_change',
          before: { rol: antes }, after: { rol: 'Administrador' },
          reason: 'Promoción ejecutada desde npm run upgrade.',
        });
        anotar('Usuario promovido', `${u.username}: ${antes} → Administrador`);
      }
    }

    // ------------------------------------------------------- Trazabilidad
    if (acciones.length) {
      audit({
        entityType: 'system', entityId: 'upgrade', entityLabel: 'Puesta al día del catálogo',
        action: 'upgrade', after: { cambios: acciones.length, detalle: acciones },
        reason: 'npm run upgrade',
      });
    }

    if (dryRun) throw new SimulacionTerminada();
    return acciones;
  });

  try {
    aplicar();
  } catch (err) {
    if (!(err instanceof SimulacionTerminada)) throw err;
    // La transacción se revirtió: nada quedó escrito.
  }

  const verbo = dryRun ? 'Se aplicarían' : 'Aplicados';
  if (!acciones.length) {
    log('[upgrade] La base ya está al día con el catálogo. Sin cambios.');
  } else {
    log(`[upgrade] ${verbo} ${acciones.length} cambio(s):`);
    for (const a of acciones) log(`  · ${a.grupo}: ${a.detalle}`);
    if (dryRun) log('\n[upgrade] Simulación: no se escribió nada. Repita sin --dry-run para aplicar.');
    else log('\n[upgrade] Listo. El historial de movimientos no se modificó.');
  }
  return acciones;
}

/** Señal interna para revertir la transacción en modo simulación. */
class SimulacionTerminada extends Error {}

if (esEjecutadoDirectamente(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { console.log(HELP); process.exit(0); }
    upgrade(opts);
  } catch (err) {
    console.error(`[upgrade] ${err.message}`);
    process.exit(1);
  }
}
