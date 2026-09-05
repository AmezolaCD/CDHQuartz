import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';

// Base de datos aislada por corrida.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cdh-test-'));
process.env.CDH_DATA_DIR = TMP;
process.env.CDH_DB_FILE = path.join(TMP, 'test.sqlite');

const { db, one, all } = await import('../server/lib/db.js');
const { seed } = await import('../server/db/seed.js');
const settingsMod = await import('../server/lib/settings.js');
const { loadSettings } = settingsMod;
const { withPermissions, findUserByUsername } = await import('../server/lib/auth.js');
const { recordMovement, getRoomByNumber, MovementError } = await import('../server/lib/movements.js');
const stats = await import('../server/lib/stats.js');
const { FLOOR_MAP } = await import('../server/db/catalog.js');
const upgradeMod = await import('../server/db/upgrade.js');

const user = (name) => withPermissions(findUserByUsername(name));

before(() => { seed({ quiet: true }); loadSettings(); });

describe('Distribución de habitaciones', () => {
  test('el hotel tiene exactamente 155 habitaciones en 9 pisos', () => {
    assert.equal(one('SELECT COUNT(*) n FROM rooms').n, 155);
    assert.equal(one('SELECT COUNT(*) n FROM floors').n, 9);
    assert.equal(Number(one("SELECT value v FROM settings WHERE key='target_room_count'").v), 155);
  });

  test('existen las habitaciones terminadas en 01 de cada piso', () => {
    for (const n of ['301', '401', '501', '601', '701', '801', '901', '1001', '1101']) {
      assert.ok(getRoomByNumber(n), `falta la habitación ${n}`);
    }
  });

  test('la posición visual coincide con el rack y no hay huecos ocupados', () => {
    for (const floor of FLOOR_MAP) {
      floor.rooms.forEach((num, col) => {
        const row = one('SELECT number FROM rooms WHERE grid_row = @r AND grid_col = @c',
          { r: floor.number, c: col + 1 });
        if (num === null) assert.equal(row, undefined, `la columna ${col + 1} del piso ${floor.number} debe quedar vacía`);
        else assert.equal(row?.number, String(num));
      });
    }
  });

  test('no existen habitaciones fuera del rack', () => {
    // El rack salta estos números en todos los pisos donde no aparecen.
    for (const n of ['407', '409', '507', '509', '511', '521', '607', '609', '707', '709',
                     '807', '809', '907', '909', '1007', '1009', '1105']) {
      assert.equal(getRoomByNumber(n), undefined, `la habitación ${n} no debería existir`);
    }
    assert.equal(one("SELECT COUNT(*) n FROM rooms WHERE number LIKE '9%' AND length(number) = 3").n, 19,
      'el piso 9 debe tener 19 habitaciones');
  });

  test('cada habitación arranca con todos los campos del catálogo', () => {
    const fields = one('SELECT COUNT(*) n FROM fields WHERE active = 1').n;
    const details = one("SELECT COUNT(*) n FROM room_details WHERE room_id = (SELECT id FROM rooms WHERE number='618')").n;
    assert.equal(details, fields);
  });
});

describe('Registro transaccional', () => {
  test('un movimiento actualiza estado, historial y auditoría a la vez', () => {
    const room = getRoomByNumber('701');
    const before = one('SELECT COUNT(*) n FROM audit_log').n;
    const res = recordMovement({
      roomId: room.id, user: user('supervisor'), movementTypeCode: 'CLEAN_DONE',
      details: [{ fieldCode: 'limpieza', value: 'Terminada' }],
      comment: 'Limpieza verificada.',
    });
    assert.equal(res.movementIds.length, 2);          // acción + campo
    assert.equal(res.room.status_code, 'LIMPIEZA_TERMINADA');
    assert.equal(one('SELECT COUNT(*) n FROM audit_log').n, before + 1);
    const detail = one(`SELECT value FROM room_details
      WHERE room_id = @r AND field_id = (SELECT id FROM fields WHERE code='limpieza')`, { r: room.id });
    assert.equal(detail.value, 'Terminada');
  });

  test('el historial conserva valor anterior y nuevo', () => {
    const room = getRoomByNumber('702');
    recordMovement({ roomId: room.id, user: user('supervisor'),
      details: [{ fieldCode: 'blancos', value: 'Dañado' }], comment: 'Sábana con quemadura.' });
    const m = one(`SELECT * FROM movements WHERE room_id = @r AND field_label = 'Blancos'`, { r: room.id });
    assert.equal(m.old_value, 'Completo');
    assert.equal(m.new_value, 'Dañado');
    assert.equal(m.is_incident, 1);
    assert.equal(m.comment, 'Sábana con quemadura.');
    assert.ok(m.user_name && m.department_name && m.local_date && m.local_time && m.created_epoch);
  });

  test('si una parte falla, se revierte todo', () => {
    const room = getRoomByNumber('703');
    const movesBefore = one('SELECT COUNT(*) n FROM movements').n;
    const statusBefore = room.status_code;
    assert.throws(() => recordMovement({
      roomId: room.id, user: user('supervisor'), movementTypeCode: 'BLOCK',
      comment: 'Prueba de reversión.',
      photos: [{ filename: null }],   // viola NOT NULL después de insertar el movimiento
    }));
    assert.equal(one('SELECT COUNT(*) n FROM movements').n, movesBefore);
    assert.equal(getRoomByNumber('703').status_code, statusBefore);
  });

  test('un guardado sin cambios reales no genera movimiento', () => {
    const room = getRoomByNumber('704');
    assert.throws(
      () => recordMovement({ roomId: room.id, user: user('supervisor'),
        details: [{ fieldCode: 'limpieza', value: 'Pendiente' }] }),
      (e) => e instanceof MovementError && /No hay cambios/.test(e.message));
  });

  test('las acciones que exigen comentario lo exigen de verdad', () => {
    const room = getRoomByNumber('705');
    assert.throws(
      () => recordMovement({ roomId: room.id, user: user('supervisor'), movementTypeCode: 'DAMAGE' }),
      (e) => /requiere un comentario/.test(e.message));
  });
});

describe('Inmutabilidad del historial', () => {
  test('los movimientos no admiten UPDATE ni DELETE', () => {
    const id = one('SELECT id FROM movements LIMIT 1').id;
    assert.throws(() => db.prepare('UPDATE movements SET comment = ? WHERE id = ?').run('alterado', id));
    assert.throws(() => db.prepare('DELETE FROM movements WHERE id = ?').run(id));
  });

  test('la bitácora de auditoría no admite UPDATE ni DELETE', () => {
    const id = one('SELECT id FROM audit_log LIMIT 1').id;
    assert.throws(() => db.prepare('UPDATE audit_log SET reason = ? WHERE id = ?').run('x', id));
    assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id = ?').run(id));
  });

  test('habitaciones y usuarios no se eliminan físicamente', () => {
    assert.throws(() => db.prepare('DELETE FROM rooms WHERE id = 1').run());
    assert.throws(() => db.prepare('DELETE FROM users WHERE id = 1').run());
  });

  test('una corrección es un movimiento nuevo que apunta al anterior', () => {
    const room = getRoomByNumber('706');
    const first = recordMovement({ roomId: room.id, user: user('supervisor'),
      details: [{ fieldCode: 'minibar', value: 'Consumido' }], comment: 'Registro inicial.' });
    const fix = recordMovement({ roomId: room.id, user: user('supervisor'),
      details: [{ fieldCode: 'minibar', value: 'Completo' }],
      comment: 'Corrección: se capturó la habitación equivocada.',
      correctsMovementId: first.primaryId });
    const m = one('SELECT * FROM movements WHERE id = @id', { id: fix.primaryId });
    assert.equal(m.corrects_movement_id, first.primaryId);
    // El movimiento original sigue intacto.
    assert.ok(one('SELECT id FROM movements WHERE id = @id', { id: first.primaryId }));
  });
});

describe('Permisos y alcance por departamento', () => {
  test('Ama de Llaves no puede escribir campos de Sistemas', () => {
    const room = getRoomByNumber('714');
    assert.throws(
      () => recordMovement({ roomId: room.id, user: user('amadellaves'),
        details: [{ fieldCode: 'wifi', value: 'Sin servicio' }] }),
      (e) => e.status === 403);
  });

  test('Sistemas sí puede escribir sus propios campos', () => {
    const room = getRoomByNumber('708');
    const res = recordMovement({ roomId: room.id, user: user('sistemas'),
      details: [{ fieldCode: 'wifi', value: 'Sin servicio' }], comment: 'AP sin responder.' });
    assert.equal(res.detailsChanged, 1);
  });

  test('Gerencia consulta pero no registra movimientos', () => {
    const room = getRoomByNumber('710');
    assert.throws(
      () => recordMovement({ roomId: room.id, user: user('gerencia'), movementTypeCode: 'NOTE', comment: 'x' }),
      (e) => e.status === 403);
  });

  test('Recepción registra observaciones generales pero no cambia el estado', () => {
    const room = getRoomByNumber('711');
    const res = recordMovement({ roomId: room.id, user: user('recepcion'),
      movementTypeCode: 'NOTE', comment: 'El huésped reporta ruido en el pasillo.' });
    assert.equal(res.movementIds.length, 1);
    assert.throws(
      () => recordMovement({ roomId: room.id, user: user('recepcion'), movementTypeCode: 'BLOCK', comment: 'x' }),
      (e) => e.status === 403);
  });
});

describe('Incidencias y reincidencia', () => {
  test('un valor marcado como incidencia abre incidencia', () => {
    const room = getRoomByNumber('712');
    recordMovement({ roomId: room.id, user: user('mantenimiento'),
      details: [{ fieldCode: 'plomeria', value: 'Falla' }], comment: 'Fuga bajo el lavabo.' });
    const abiertas = stats.openIncidents().filter((i) => i.room_id === room.id);
    assert.equal(abiertas.length, 1);
    assert.equal(abiertas[0].field_label, 'Plomería');
  });

  test('corregir el valor cierra la incidencia', () => {
    const room = getRoomByNumber('712');
    recordMovement({ roomId: room.id, user: user('mantenimiento'),
      details: [{ fieldCode: 'plomeria', value: 'OK' }], comment: 'Reparada y probada.' });
    assert.equal(stats.openIncidents().filter((i) => i.room_id === room.id).length, 0);
  });

  test('la reincidencia cuenta eventos, no filas del historial', () => {
    const room = getRoomByNumber('713');
    // Un solo reporte que toca dos campos = una incidencia, no tres.
    recordMovement({ roomId: room.id, user: user('mantenimiento'), movementTypeCode: 'MAINT_REPORT',
      comment: 'Falla eléctrica y de clima.',
      details: [{ fieldCode: 'electricidad', value: 'Falla' }, { fieldCode: 'hvac', value: 'Falla' }] });
    assert.equal(stats.recurrence({ minCount: 2 }).rooms.find((r) => r.room_id === room.id), undefined);

    recordMovement({ roomId: room.id, user: user('mantenimiento'), movementTypeCode: 'MAINT_REPORT',
      comment: 'Segundo reporte: la falla eléctrica reaparece.' });
    const rec = stats.recurrence({ minCount: 2 }).rooms.find((r) => r.room_id === room.id);
    assert.ok(rec, 'la habitación debe aparecer como reincidente tras dos eventos');
    assert.equal(rec.incidents, 2);
  });

  test('los umbrales de reincidencia se reportan por bucket', () => {
    const buckets = stats.recurrence({ minCount: 2 }).buckets.map((b) => b.threshold);
    assert.deepEqual(buckets, [2, 3, 5, 10]);
  });
});

describe('Indicadores y atención', () => {
  test('los contadores del panel suman sobre habitaciones activas', () => {
    const o = stats.overview();
    assert.equal(o.total, 155);
    assert.equal(o.target, 155);
    assert.ok(o.listas + o.limpieza + o.mantenimiento + o.bloqueadas <= o.total);
  });

  test('"Requiere atención" explica el motivo de cada habitación', () => {
    const att = stats.attention();
    assert.ok(att.items.length > 0);
    for (const item of att.items) {
      assert.ok(item.reasons.length > 0, `la habitación ${item.number} aparece sin motivo`);
      assert.ok(item.reasons.every((r) => r.label));
    }
  });

  test('cada movimiento responde qué, quién, cuándo, dónde y por qué', () => {
    const m = one(`SELECT * FROM movements WHERE comment IS NOT NULL ORDER BY id DESC LIMIT 1`);
    assert.ok(m.action, 'QUÉ');
    assert.ok(m.user_name, 'QUIÉN');
    assert.ok(m.created_at && m.local_date && m.local_time && m.timezone, 'CUÁNDO');
    assert.ok(m.room_number && m.floor_number, 'DÓNDE');
    assert.ok(m.department_name, 'QUÉ DEPARTAMENTO');
    assert.ok(m.comment, 'POR QUÉ');
    assert.ok(m.old_status_name && m.new_status_name, 'ANTES / DESPUÉS');
  });
});

describe('Puesta al día del catálogo (npm run upgrade)', () => {
  test('sobre una base ya al día no hace nada', () => {
    const { upgrade } = upgradeMod;
    assert.equal(upgrade({ quiet: true }).length, 0);
  });

  test('repone un campo faltante y lo siembra en todas las habitaciones', () => {
    const { upgrade } = upgradeMod;
    const field = one("SELECT id FROM fields WHERE code = 'cast'");
    db.prepare('DELETE FROM room_details WHERE field_id = @id').run({ id: field.id });
    db.prepare('DELETE FROM fields WHERE id = @id').run({ id: field.id });

    const acciones = upgrade({ quiet: true });
    assert.ok(acciones.some((a) => /Cast/.test(a.detalle)), 'debe reponer el campo');

    const rooms = one('SELECT COUNT(*) AS n FROM rooms').n;
    const conCampo = one(`
      SELECT COUNT(*) AS n FROM room_details rd
        JOIN fields f ON f.id = rd.field_id WHERE f.code = 'cast'`).n;
    assert.equal(conCampo, rooms, 'toda habitación existente recibe el campo nuevo');
    assert.equal(upgrade({ quiet: true }).length, 0, 'la segunda pasada ya no cambia nada');
  });

  test('no sobrescribe lo que un administrador configuró', () => {
    const { upgrade } = upgradeMod;
    db.prepare("UPDATE room_statuses SET name = 'Lista para vender' WHERE code = 'DISPONIBLE'").run();
    db.prepare("UPDATE settings SET value = '45' WHERE key = 'recurrence_window_days'").run();

    upgrade({ quiet: true });

    assert.equal(one("SELECT name FROM room_statuses WHERE code = 'DISPONIBLE'").name, 'Lista para vender');
    assert.equal(one("SELECT value FROM settings WHERE key = 'recurrence_window_days'").value, '45');
  });

  test('la simulación no escribe nada', () => {
    const { upgrade } = upgradeMod;
    db.prepare("DELETE FROM settings WHERE key = 'max_photo_mb'").run();
    const previstas = upgrade({ quiet: true, dryRun: true });
    assert.ok(previstas.length > 0, 'debe anunciar el cambio');
    assert.equal(one("SELECT COUNT(*) AS n FROM settings WHERE key = 'max_photo_mb'").n, 0,
      'pero no haberlo escrito');
    upgrade({ quiet: true });
    assert.equal(one("SELECT COUNT(*) AS n FROM settings WHERE key = 'max_photo_mb'").n, 1);
  });

  test('cambia la zona horaria sin alterar los movimientos ya registrados', () => {
    const { upgrade } = upgradeMod;
    const antes = all('SELECT id, local_date, local_time, timezone FROM movements ORDER BY id');
    assert.ok(antes.length > 0, 'la prueba necesita historial previo');

    upgrade({ quiet: true, timezone: 'America/Tijuana' });
    assert.equal(one("SELECT value FROM settings WHERE key = 'timezone'").value, 'America/Tijuana');

    const despues = all('SELECT id, local_date, local_time, timezone FROM movements ORDER BY id');
    assert.deepEqual(despues, antes, 'el historial conserva su propio sello temporal');
  });

  test('promueve a un usuario a Administrador y revoca sus sesiones', () => {
    const { upgrade } = upgradeMod;
    const sis = one("SELECT id FROM users WHERE username = 'sistemas'");
    db.prepare("UPDATE users SET role_id = (SELECT id FROM roles WHERE code='SIS') WHERE id = @id")
      .run({ id: sis.id });

    upgrade({ quiet: true, promote: 'sistemas' });

    const rol = one(`SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = @id`, { id: sis.id });
    assert.equal(rol.code, 'ADMIN');
    assert.equal(one('SELECT COUNT(*) AS n FROM sessions WHERE user_id = @id AND revoked_at IS NULL', { id: sis.id }).n, 0);
  });

  test('rechaza una zona horaria inválida y un usuario inexistente', () => {
    const { upgrade } = upgradeMod;
    assert.throws(() => upgrade({ quiet: true, timezone: 'Marte/Olympus' }), /Zona horaria inválida/);
    assert.throws(() => upgrade({ quiet: true, promote: 'nadie' }), /No existe el usuario/);
  });
});

describe('Scripts de línea de comandos', () => {
  // Un script que no arranca no falla: termina en silencio. Estas pruebas
  // exigen salida real, porque el guardián de "módulo principal" se rompió
  // en Windows y `npm run seed`/`upgrade` no hacían nada sin avisar.
  const { spawnSync } = childProcess;
  const correr = (script, args = []) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdh-cli-'));
    // CDH_DB_FILE lo fija esta misma suite y apunta a su base ya sembrada:
    // hay que quitarlo para que el hijo use su directorio temporal.
    const { CDH_DB_FILE, ...limpio } = process.env;
    const r = spawnSync(process.execPath, [path.join('server', 'db', script), ...args], {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: { ...limpio, CDH_DATA_DIR: dir, CDH_SEED_PASSWORD: 'Cli#Prueba2026' },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    return r;
  };

  test('seed.js imprime lo que hizo', () => {
    const r = correr('seed.js');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[seed\]/, 'debe informar; el silencio significa que no se ejecutó');
    assert.match(r.stdout, /155/);
  });

  test('upgrade.js imprime lo que hizo', () => {
    const r = correr('upgrade.js');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[upgrade\]/, 'debe informar; el silencio significa que no se ejecutó');
  });

  test('upgrade.js rechaza una opción desconocida con código distinto de 0', () => {
    const r = correr('upgrade.js', ['--inventada']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Opción desconocida/);
  });

  test('el guardián de módulo principal no depende del formato de ruta', async () => {
    const { esEjecutadoDirectamente } = await import('../server/lib/cli.js');
    const { pathToFileURL } = await import('node:url');
    const propio = path.resolve(import.meta.dirname, '..', 'server', 'db', 'upgrade.js');
    assert.equal(esEjecutadoDirectamente(pathToFileURL(propio).href, propio), true);
    assert.equal(esEjecutadoDirectamente('file:///otra/cosa.js', propio), false);
    assert.equal(esEjecutadoDirectamente('file:///x.js', undefined), false);
  });
});

describe('Reportes entre departamentos y notificaciones dirigidas', () => {
  const depto = (code) => one('SELECT id FROM departments WHERE code = @code', { code }).id;
  const destinatarios = (notifId) => all(`
    SELECT d.code FROM notification_recipients r
      JOIN departments d ON d.id = r.department_id
     WHERE r.notification_id = @id ORDER BY d.code`, { id: notifId }).map((x) => x.code);

  test('Ama de Llaves puede reportar a Sistemas, aunque no sea su área', () => {
    const room = getRoomByNumber('714');
    const res = recordMovement({
      roomId: room.id, user: user('amadellaves'), movementTypeCode: 'SYS_REPORT',
      comment: 'La TV no da señal.',
    });
    assert.equal(res.room.status_code, 'SIS_PENDIENTE');
  });

  test('pero no puede cerrar el trabajo de Sistemas', () => {
    const room = getRoomByNumber('715');
    assert.throws(
      () => recordMovement({ roomId: room.id, user: user('amadellaves'), movementTypeCode: 'SYS_DONE' }),
      (e) => e.status === 403);
  });

  test('el reporte avisa al área destino y a Ama de Llaves', () => {
    const room = getRoomByNumber('716');
    const res = recordMovement({
      roomId: room.id, user: user('amadellaves'), movementTypeCode: 'SYS_REPORT',
      comment: 'El panel táctil no responde.',
    });
    const n = one('SELECT * FROM notifications WHERE movement_id = @id', { id: res.primaryId });
    assert.ok(n, 'debe generarse una notificación');
    assert.deepEqual(destinatarios(n.id), ['AMA', 'SIS']);
  });

  test('el cierre también avisa a ambos', () => {
    const room = getRoomByNumber('717');
    recordMovement({ roomId: room.id, user: user('amadellaves'), movementTypeCode: 'SYS_REPORT', comment: 'WiFi caído.' });
    const res = recordMovement({
      roomId: room.id, user: user('sistemas'), movementTypeCode: 'SYS_DONE',
      comment: 'Punto de acceso reiniciado.',
    });
    const n = one('SELECT * FROM notifications WHERE movement_id = @id', { id: res.primaryId });
    assert.ok(n, 'completar también debe notificar');
    assert.deepEqual(destinatarios(n.id), ['AMA', 'SIS']);
  });

  test('un reporte de mantenimiento avisa a Mantenimiento y a Ama de Llaves', () => {
    const room = getRoomByNumber('718');
    const res = recordMovement({
      roomId: room.id, user: user('amadellaves'), movementTypeCode: 'MAINT_REPORT',
      comment: 'Fuga en el lavabo.',
    });
    const n = one('SELECT * FROM notifications WHERE movement_id = @id', { id: res.primaryId });
    assert.deepEqual(destinatarios(n.id), ['AMA', 'MTTO']);
  });

  test('la copia a Ama de Llaves es configurable', () => {
    const { setSettingValue } = settingsMod;
    setSettingValue('notify_housekeeping_copy', '0', null);
    const room = getRoomByNumber('719');
    const res = recordMovement({
      roomId: room.id, user: user('sistemas'), movementTypeCode: 'SYS_REPORT',
      comment: 'Extensión sin tono.',
    });
    const n = one('SELECT * FROM notifications WHERE movement_id = @id', { id: res.primaryId });
    assert.deepEqual(destinatarios(n.id), ['SIS'], 'sin copia, sólo el área destino');
    setSettingValue('notify_housekeeping_copy', '1', null);
  });
});
