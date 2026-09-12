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

/**
 * Entradas del catálogo que el CDH deja de usar. Nunca se borran —el historial
 * las referencia y es inmutable—: se dan de baja lógica, y sólo bajo tres
 * condiciones que la hacen segura y reversible desde Administración.
 */
const RETIRADOS = [
  // Los estados propios del CDH ceden el sitio a los de Arpón: el rack y la
  // pantalla de Ama de Llaves del PMS tienen que decir lo mismo.
  ...[
    ['DISPONIBLE', 'Disponible'], ['OCUPADA', 'En casa'], ['VACIA', 'Vacía'],
    ['EN_LIMPIEZA', 'En limpieza'], ['LIMPIEZA_TERMINADA', 'Limpieza terminada'],
    ['INSPECCION_PENDIENTE', 'Inspección pendiente'], ['INSPECCIONADA', 'Inspeccionada'],
    ['MANT_PENDIENTE', 'Mantenimiento pendiente'], ['EN_MANTENIMIENTO', 'En mantenimiento'],
    ['SIS_PENDIENTE', 'Sistemas pendiente'], ['EN_SISTEMAS', 'En atención de Sistemas'],
    ['BLOQUEADA', 'Bloqueada'], ['REQUIERE_ATENCION', 'Requiere atención'],
  ].map(([code, de]) => ({
    tabla: 'room_statuses', code, de,
    porque: 'el hotel pasa a los estados de Arpón',
  })),
  // El eje de ocupación se queda sin trabajo: los estados de Arpón ya dicen si
  // hay huésped, y lo que hacía falta de verdad —si estará dentro cuando suba
  // el área responsable— es ahora un dato del reporte.
  ...[
    ['VACANTE', 'Huésped ausente'], ['OCUPADA', 'Huésped ahí'],
    ['SALIDA', 'Salida'], ['NO_MOLESTAR', 'No molestar'],
  ].map(([code, de]) => ({
    tabla: 'room_occupancies', code, de,
    porque: 'la ocupación pasó a ser un dato del reporte, no un estado de la habitación',
  })),
  // Acciones que apuntaban a estados que ya no existen.
  ...[
    ['CLEAN_START', 'Iniciar limpieza'], ['MAINT_START', 'Iniciar mantenimiento'],
    ['SYS_START', 'Iniciar atención de Sistemas'], ['BLOCK', 'Bloquear habitación'],
    ['CHECK_IN', 'Entrada de huésped'], ['CHECK_OUT', 'Salida de huésped'],
    ['DND_ON', 'Marcar no molestar'], ['DND_OFF', 'Quitar no molestar'],
    ['OCCUPANCY_CHANGE', 'Cambio de ocupación'],
  ].map(([code, de]) => ({
    tabla: 'movement_types', code, de,
    porque: 'apuntaba a un estado que el hotel ya no usa',
  })),
];

/**
 * A dónde va cada habitación que esté en un estado que se retira. Se apoya en
 * la ocupación que el CDH venía registrando —el dato está ahí y es el que
 * distingue una habitación a medio limpiar con el huésped en casa de una de
 * salida—, y nunca manda a un estado vendible algo que no lo fuera ya.
 */
const EQUIVALENCIAS = [
  { de: 'DISPONIBLE',           conHuesped: 'OCUPADO_LIMPIO', sinHuesped: 'DISPONIBLE_LIMPIO' },
  { de: 'INSPECCIONADA',        conHuesped: 'OCUPADO_LIMPIO', sinHuesped: 'DISPONIBLE_LIMPIO' },
  { de: 'LIMPIEZA_TERMINADA',   conHuesped: 'OCUPADO_LIMPIO', sinHuesped: 'DISPONIBLE_LIMPIO' },
  { de: 'OCUPADA',              conHuesped: 'OCUPADO_LIMPIO', sinHuesped: 'OCUPADO_LIMPIO' },
  { de: 'EN_LIMPIEZA',          conHuesped: 'OCUPADO_SUCIO',  sinHuesped: 'SALIDA' },
  { de: 'INSPECCION_PENDIENTE', conHuesped: 'OCUPADO_SUCIO',  sinHuesped: 'SALIDA' },
  { de: 'VACIA',                conHuesped: 'OCUPADO_SUCIO',  sinHuesped: 'SALIDA' },
  // Con trabajo pendiente, fuera de servicio: nada que no se pudiera vender
  // antes acaba pudiéndose vender después de la puesta al día.
  { de: 'MANT_PENDIENTE',       conHuesped: 'FUERA_SERVICIO', sinHuesped: 'FUERA_SERVICIO' },
  { de: 'EN_MANTENIMIENTO',     conHuesped: 'FUERA_SERVICIO', sinHuesped: 'FUERA_SERVICIO' },
  { de: 'SIS_PENDIENTE',        conHuesped: 'FUERA_SERVICIO', sinHuesped: 'FUERA_SERVICIO' },
  { de: 'EN_SISTEMAS',          conHuesped: 'FUERA_SERVICIO', sinHuesped: 'FUERA_SERVICIO' },
  { de: 'BLOQUEADA',            conHuesped: 'FUERA_SERVICIO', sinHuesped: 'FUERA_SERVICIO' },
  { de: 'REQUIERE_ATENCION',    conHuesped: 'FUERA_SERVICIO', sinHuesped: 'FUERA_SERVICIO' },
];

/** Permisos que dejan de existir. No los referencia el historial. */
const PERMISOS_RETIRADOS = ['room.occupancy'];

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
  // Un aviso NO es un cambio: se cuenta aparte para que una advertencia que
  // se repite en cada pasada no impida que la base se declare al día.
  const avisos = [];

  const aplicar = transaction(() => {
    const idPor = (tabla, code) => one(`SELECT id FROM ${tabla} WHERE code = @code`, { code })?.id ?? null;

    // ------------------------------------------------------- Departamentos
    for (const d of DEPARTMENTS) {
      if (!idPor('departments', d.code)) { insert('departments', d); anotar('Departamento', d.name); }
    }

    // ---------------------------------------------------------- Permisos
    // Se anota cuáles nacen en esta pasada: un permiso que hasta ahora no
    // existía no pudo ser quitado a nadie a propósito, así que sí debe llegar
    // a los roles del sistema que lo declaran (ver más abajo).
    const permisosNuevos = new Set();
    for (const p of PERMISSIONS) {
      if (!idPor('permissions', p.code)) {
        insert('permissions', p);
        permisosNuevos.add(p.code);
        anotar('Permiso', `${p.name} (${p.code})`);
      }
    }

    // ------------------------------------------------------------- Roles
    for (const r of ROLES) {
      const { permissions, ...fila } = r;
      const existente = one('SELECT id, name, is_system FROM roles WHERE code = @code', { code: r.code });
      if (!existente) {
        const id = insert('roles', fila);
        for (const code of permissions) {
          const pid = idPor('permissions', code);
          if (pid) insert('role_permissions', { role_id: id, permission_id: pid });
        }
        anotar('Rol', r.name);
        continue;
      }
      // Un rol del sistema recibe los permisos que ACABAN de crearse y que el
      // catálogo le asigna. Los permisos que ya existían no se tocan: quitar
      // uno es una decisión del administrador y se respeta.
      if (!existente.is_system || !permisosNuevos.size) continue;
      for (const code of permissions) {
        if (!permisosNuevos.has(code)) continue;
        const pid = idPor('permissions', code);
        if (!pid) continue;
        insert('role_permissions', { role_id: existente.id, permission_id: pid });
        anotar('Permiso nuevo al rol', `${existente.name}: ${code}`);
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
    ROOM_STATUSES.forEach((st, i) => {
      if (idPor('room_statuses', st.code)) return;
      const { clean_status, ...fila } = st;
      insert('room_statuses', { ...fila, sort_order: i + 1, is_system: 1 });
      anotar('Estado', st.name);
    });
    // El destino al terminar la limpieza se enlaza en una segunda vuelta:
    // apunta a otro estado de la misma tabla, que puede acabar de nacer.
    for (const st of ROOM_STATUSES) {
      if (!st.clean_status) continue;
      const fila = one('SELECT id, clean_status_id FROM room_statuses WHERE code = @code', { code: st.code });
      const destino = idPor('room_statuses', st.clean_status);
      if (!fila || !destino || fila.clean_status_id) continue;
      db.prepare('UPDATE room_statuses SET clean_status_id = @destino WHERE id = @id')
        .run({ destino, id: fila.id });
      anotar('Destino al limpiar', `${st.name} → ${st.clean_status}`);
    }

    // --------------------------- Habitaciones a los estados de Arpón
    // Un estado no se puede retirar con habitaciones dentro, así que primero
    // se mueven. Se apoya en la ocupación que el CDH venía registrando —es el
    // dato que distingue una habitación a medio limpiar con el huésped en casa
    // de una de salida— y nunca manda a un estado vendible algo que no lo
    // fuera ya. La mudanza entera queda en la bitácora, habitación por
    // habitación.
    const mudanzas = [];
    for (const eq of EQUIVALENCIAS) {
      const viejo = one('SELECT id, name FROM room_statuses WHERE code = @code', { code: eq.de });
      if (!viejo) continue;
      const dentro = all(`
        SELECT r.id, r.number, COALESCE(o.counts_occupied, 0) AS conHuesped
          FROM rooms r
          LEFT JOIN room_occupancies o ON o.id = r.occupancy_id
         WHERE r.status_id = @id`, { id: viejo.id });
      for (const hab of dentro) {
        const destino = one('SELECT id, name FROM room_statuses WHERE code = @code AND active = 1',
          { code: hab.conHuesped ? eq.conHuesped : eq.sinHuesped });
        if (!destino) continue;
        db.prepare('UPDATE rooms SET status_id = @s, status_changed_at = @now WHERE id = @id')
          .run({ s: destino.id, now: new Date().toISOString(), id: hab.id });
        mudanzas.push({ habitacion: hab.number, de: viejo.name, a: destino.name });
      }
    }
    if (mudanzas.length) {
      const porDestino = {};
      for (const m of mudanzas) {
        const clave = `${m.de} → ${m.a}`;
        porDestino[clave] = (porDestino[clave] ?? 0) + 1;
      }
      anotar('Habitaciones al catálogo de Arpón',
        Object.entries(porDestino).map(([k, n]) => `${n} × ${k}`).join('; '));
      audit({
        entityType: 'system', entityId: 'estados-arpon',
        entityLabel: 'Paso a los estados de Arpón',
        action: 'upgrade', after: { habitaciones: mudanzas },
        reason: 'El catálogo de estados pasa a ser el de Arpón; ninguna habitación puede quedar en un estado retirado.',
      });
    }

    // Hecha la mudanza, la ocupación de la habitación deja de tener lectores:
    // la columna se vacía para que el eje pueda retirarse de verdad. Lo que
    // decía no se pierde —cada movimiento guarda su propia copia y la mudanza
    // entera queda arriba en la bitácora—, pero deja de ser estado vigente.
    const conOcupacion = one('SELECT COUNT(*) AS n FROM rooms WHERE occupancy_id IS NOT NULL').n;
    if (conOcupacion && one("SELECT 1 x FROM room_occupancies WHERE code = 'VACANTE' AND active = 1")) {
      db.prepare('UPDATE rooms SET occupancy_id = NULL, occupancy_changed_at = NULL').run();
      anotar('Ocupación retirada de la habitación',
        `${conOcupacion} habitaciones dejan de llevar un eje de ocupación`);
    }

    // ------------------------------------------------ Bajas del catálogo
    // Se retira una entrada sólo si: sigue activa, conserva el nombre con el
    // que se publicó —si el hotel la renombró, la está usando para otra cosa—
    // y nada la está usando. Si algo la usa se deja como está y se avisa: dar
    // de baja una entrada en uso la escondería de los catálogos sin sacar de
    // ella a quien la usa.
    const enUsoPor = {
      room_statuses: (id) => one('SELECT COUNT(*) AS n FROM rooms WHERE status_id = @id', { id }).n,
      room_occupancies: (id) => one('SELECT COUNT(*) AS n FROM rooms WHERE occupancy_id = @id', { id }).n,
      // El historial guarda su propia copia del nombre de la acción, así que
      // retirarla no deja ningún movimiento huérfano.
      movement_types: () => 0,
    };
    for (const r of RETIRADOS) {
      const fila = one(`SELECT id, name, active FROM ${r.tabla} WHERE code = @code`, { code: r.code });
      if (!fila || !fila.active || fila.name !== r.de) continue;
      const enUso = enUsoPor[r.tabla](fila.id);
      if (enUso) {
        avisos.push(`"${r.de}" no se retira: ${
          enUso === 1 ? 'hay 1 habitación' : `hay ${enUso} habitaciones`
        } usándolo. Muévalas y vuelva a ejecutar la puesta al día.`);
        continue;
      }
      db.prepare(`UPDATE ${r.tabla} SET active = 0 WHERE id = @id`).run({ id: fila.id });
      anotar('Retirado del catálogo', `${r.de} — ${r.porque}`);
    }

    // Los permisos no llevan baja lógica y el historial no los referencia: se
    // eliminan, y con ellos su asignación a cada rol.
    for (const code of PERMISOS_RETIRADOS) {
      const permiso = one('SELECT id, name FROM permissions WHERE code = @code', { code });
      if (!permiso) continue;
      db.prepare('DELETE FROM role_permissions WHERE permission_id = @id').run({ id: permiso.id });
      db.prepare('DELETE FROM permissions WHERE id = @id').run({ id: permiso.id });
      anotar('Permiso retirado', `${permiso.name} (${code})`);
    }

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

  for (const a of avisos) log(`[upgrade] Aviso: ${a}`);

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
