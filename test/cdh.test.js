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
const { recordMovement, recordBulkMovement, getRoomByNumber, MovementError } = await import('../server/lib/movements.js');
const stats = await import('../server/lib/stats.js');
const { FLOOR_MAP } = await import('../server/db/catalog.js');
const upgradeMod = await import('../server/db/upgrade.js');
const { backup } = await import('../server/db/backup.js');
const cleaning = await import('../server/lib/cleaning.js');
const Database = (await import('better-sqlite3')).default;

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
    recordMovement({ roomId: room.id, user: user('supervisor'), statusCode: 'SALIDA' });
    const before = one('SELECT COUNT(*) n FROM audit_log').n;
    const res = recordMovement({
      roomId: room.id, user: user('supervisor'), movementTypeCode: 'CLEAN_DONE',
      details: [{ fieldCode: 'limpieza', value: 'Terminada' }],
      comment: 'Limpieza verificada.',
    });
    assert.equal(res.movementIds.length, 2);          // acción + campo
    assert.equal(res.room.status_code, 'DISPONIBLE_LIMPIO');
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
      roomId: room.id, user: user('supervisor'), movementTypeCode: 'OUT_OF_SERVICE',
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
      () => recordMovement({ roomId: room.id, user: user('supervisor'), movementTypeCode: 'DAMAGE', guestPresent: 'no' }),
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

  test('Recepción registra la entrada y la salida, pero no campos de otra área', () => {
    const room = getRoomByNumber('711');
    const res = recordMovement({ roomId: room.id, user: user('recepcion'),
      movementTypeCode: 'NOTE', comment: 'El huésped reporta ruido en el pasillo.' });
    assert.equal(res.movementIds.length, 1);
    // Mueve el estado del huésped, que es su trabajo…
    const entrada = recordMovement({ roomId: room.id, user: user('recepcion'), movementTypeCode: 'GUEST_IN' });
    assert.equal(entrada.room.status_code, 'OCUPADO_LIMPIO');
    // …pero no escribe en los campos de Sistemas.
    assert.throws(
      () => recordMovement({ roomId: room.id, user: user('recepcion'),
        details: [{ fieldCode: 'wifi', value: 'Sin servicio' }] }),
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
      comment: 'Falla eléctrica y de clima.', guestPresent: 'no',
      details: [{ fieldCode: 'electricidad', value: 'Falla' }, { fieldCode: 'hvac', value: 'Falla' }] });
    assert.equal(stats.recurrence({ minCount: 2 }).rooms.find((r) => r.room_id === room.id), undefined);

    recordMovement({ roomId: room.id, user: user('mantenimiento'), movementTypeCode: 'MAINT_REPORT',
      comment: 'Segundo reporte: la falla eléctrica reaparece.', guestPresent: 'no' });
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

  test('el indicador y la lista de atención nunca se contradicen', () => {
    // El KPI cuenta la bandera `counts_attention`; la lista debe partir de la
    // MISMA bandera. Antes nombraba tres códigos de estado a mano, así que un
    // reporte a Sistemas sumaba en el indicador y no aparecía en la lista.
    const room = getRoomByNumber('808');
    recordMovement({
      roomId: room.id, user: user('amadellaves'), movementTypeCode: 'SYS_REPORT',
      comment: 'Televisión sin señal.', guestPresent: 'no', guestPresent: 'no',
    });
    const att = stats.attention({ limit: 400 });
    const fila = att.items.find((i) => i.number === '808');
    assert.ok(fila, 'la habitación reportada a Sistemas debe aparecer en "Requiere atención"');
    // El reporte ya no mueve el estado: lo que la pone en la lista es la
    // incidencia abierta, y el motivo tiene que decirlo.
    assert.ok(fila.reasons.some((r) => r.code === 'incidencia'));

    const marcadas = all(`
      SELECT r.number FROM rooms r JOIN room_statuses s ON s.id = r.status_id
       WHERE r.active = 1 AND s.counts_attention = 1`).map((r) => r.number);
    const enLista = new Set(att.items.map((i) => i.number));
    for (const n of marcadas) {
      assert.ok(enLista.has(n), `${n} cuenta en el indicador pero falta en la lista`);
    }
  });

  test('el bloqueo pesa más que cualquier otro motivo', () => {
    const peso = (code) => one('SELECT attention_weight w FROM room_statuses WHERE code = @code', { code }).w;
    assert.ok(peso('FUERA_SERVICIO') >= peso('DISCREPANCIA'));
    assert.ok(peso('FUERA_SERVICIO') > peso('OCUPADO_SUCIO'));
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
    db.prepare("UPDATE room_statuses SET name = 'Lista para vender' WHERE code = 'DISPONIBLE_LIMPIO'").run();
    db.prepare("UPDATE settings SET value = '45' WHERE key = 'recurrence_window_days'").run();

    upgrade({ quiet: true });

    assert.equal(one("SELECT name FROM room_statuses WHERE code = 'DISPONIBLE_LIMPIO'").name, 'Lista para vender');
    assert.equal(one("SELECT value FROM settings WHERE key = 'recurrence_window_days'").value, '45');
  });

  test('una base con los estados viejos pasa a los de Arpón sin perder ninguna habitación', () => {
    const { upgrade } = upgradeMod;
    // Se recrea la base anterior: los estados propios del CDH, activos, con
    // habitaciones dentro y el permiso de ocupación todavía asignado.
    const viejo = (code, name, extra = '') => {
      if (!one('SELECT 1 x FROM room_statuses WHERE code = @code', { code })) {
        db.prepare(`INSERT INTO room_statuses (code, name, icon, color, sort_order, is_system, active${extra ? ', ' + extra : ''})
                    VALUES (@code, @name, 'circle', '#64748b', 99, 1, 1${extra ? ', 1' : ''})`).run({ code, name });
      }
      db.prepare('UPDATE room_statuses SET name = @name, active = 1 WHERE code = @code').run({ code, name });
      return one('SELECT id FROM room_statuses WHERE code = @code', { code }).id;
    };
    const disponible = viejo('DISPONIBLE', 'Disponible');
    const enLimpieza = viejo('EN_LIMPIEZA', 'En limpieza');
    const mantPendiente = viejo('MANT_PENDIENTE', 'Mantenimiento pendiente');
    // Una base nueva ya no siembra la ocupación; se recrea la fila que la
    // base anterior sí tenía, que es el dato en el que se apoya la mudanza.
    if (!one("SELECT 1 x FROM room_occupancies WHERE code = 'OCUPADA'")) {
      db.prepare(`INSERT INTO room_occupancies (code, name, icon, color, counts_occupied, sort_order, is_system, active)
                  VALUES ('OCUPADA', 'Huésped ahí', 'user', '#2563eb', 1, 2, 1, 1)`).run();
    }
    const ocupada = one("SELECT id FROM room_occupancies WHERE code = 'OCUPADA'").id;

    const mover = (numero, estado, conHuesped = false) => {
      const id = getRoomByNumber(numero).id;
      db.prepare('UPDATE rooms SET status_id = @s, occupancy_id = @o WHERE id = @id')
        .run({ s: estado, o: conHuesped ? ocupada : null, id });
      return id;
    };
    mover('303', disponible);
    mover('304', enLimpieza);                 // sin huésped: era de salida
    mover('305', enLimpieza, true);           // con huésped: se queda otra noche
    mover('306', mantPendiente);

    const acciones = upgrade({ quiet: true });
    assert.ok(acciones.some((a) => a.grupo === 'Habitaciones al catálogo de Arpón'));

    assert.equal(getRoomByNumber('303').status_code, 'DISPONIBLE_LIMPIO');
    assert.equal(getRoomByNumber('304').status_code, 'SALIDA');
    assert.equal(getRoomByNumber('305').status_code, 'OCUPADO_SUCIO',
      'la ocupación que el CDH venía registrando distingue estos dos casos');
    assert.equal(getRoomByNumber('306').status_code, 'FUERA_SERVICIO',
      'con trabajo pendiente no puede acabar vendible');

    // Vaciados los estados viejos, se retiran; y el permiso desaparece.
    for (const code of ['DISPONIBLE', 'EN_LIMPIEZA', 'MANT_PENDIENTE']) {
      assert.equal(one('SELECT active FROM room_statuses WHERE code = @code', { code }).active, 0,
        `${code} debe quedar retirado`);
    }
    assert.equal(one("SELECT 1 x FROM permissions WHERE code = 'room.occupancy'"), undefined);
    assert.equal(one('SELECT COUNT(*) n FROM rooms').n, 155, 'ninguna habitación se pierde');

    // La mudanza queda en la bitácora, habitación por habitación.
    const registro = one(`SELECT after_json FROM audit_log WHERE entity_id = 'estados-arpon'
                           ORDER BY id DESC LIMIT 1`);
    assert.ok(registro, 'la bitácora debe conservar la mudanza');
    const detalle = JSON.parse(registro.after_json).habitaciones;
    assert.ok(detalle.some((h) => h.habitacion === '305' && h.a === 'Ocupado sucio'));

    assert.equal(upgrade({ quiet: true }).length, 0, 'la segunda pasada ya no cambia nada');
  });

  test('no retira un estado que el hotel dejó en uso', () => {
    const { upgrade } = upgradeMod;
    const id = () => one("SELECT id, active FROM room_statuses WHERE code = 'BLOQUEADA'");
    if (!id()) {
      db.prepare(`INSERT INTO room_statuses (code, name, icon, color, sort_order, is_system, active)
                  VALUES ('BLOQUEADA', 'Bloqueada', 'lock', '#7f1d1d', 99, 1, 1)`).run();
    }
    db.prepare("UPDATE room_statuses SET name = 'Bloqueada', active = 1 WHERE code = 'BLOQUEADA'").run();

    // Una habitación dentro que la equivalencia no alcanza a mover: se deja.
    const room = getRoomByNumber('307');
    const antes = room.status_id;
    db.prepare('UPDATE rooms SET status_id = @s WHERE id = @id').run({ s: id().id, id: room.id });
    db.prepare("UPDATE room_statuses SET active = 0 WHERE code = 'FUERA_SERVICIO'").run();

    assert.equal(upgrade({ quiet: true }).length, 0, 'un aviso no es un cambio');
    assert.equal(id().active, 1, 'sigue activo mientras esté en uso');

    db.prepare("UPDATE room_statuses SET active = 1 WHERE code = 'FUERA_SERVICIO'").run();
    db.prepare('UPDATE rooms SET status_id = @s WHERE id = @id').run({ s: antes, id: room.id });
    upgrade({ quiet: true });
    assert.equal(id().active, 0);
  });

  test('renombra un campo sin perder lo que las habitaciones ya tenían', () => {
    const { upgrade } = upgradeMod;
    const campo = () => one("SELECT id, label FROM fields WHERE code = 'minibar'");

    // El valor de una habitación cuelga del id del campo, no de su nombre:
    // por eso el código no cambia y el histórico sobrevive al renombre.
    const room = getRoomByNumber('311');
    recordMovement({ roomId: room.id, user: user('amadellaves'),
      details: [{ fieldCode: 'minibar', value: 'Consumido' }], comment: 'Se repone en el turno.' });
    const antes = campo().id;

    db.prepare("UPDATE fields SET label = 'Minibar' WHERE code = 'minibar'").run();
    const acciones = upgrade({ quiet: true });
    assert.ok(acciones.some((a) => a.grupo === 'Nombre más claro'));
    assert.equal(campo().label, 'Refrigerador');
    assert.equal(campo().id, antes, 'el campo es el mismo, sólo cambió su etiqueta');
    assert.equal(
      one(`SELECT value v FROM room_details WHERE room_id = @r AND field_id = @f`,
        { r: room.id, f: antes }).v, 'Consumido', 'el valor de la habitación sigue ahí');
    assert.equal(upgrade({ quiet: true }).length, 0, 'la condición se agota sola');

    // Si el hotel lo renombró a su manera, su decisión manda.
    db.prepare("UPDATE fields SET label = 'Frigobar' WHERE code = 'minibar'").run();
    upgrade({ quiet: true });
    assert.equal(campo().label, 'Frigobar');
    db.prepare("UPDATE fields SET label = 'Refrigerador' WHERE code = 'minibar'").run();
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

describe('Respaldo en caliente', () => {
  test('la copia es consistente aunque haya escrituras en curso', async () => {
    // Copiar el archivo con `cp` mientras el servidor escribe deja parte de
    // los datos en el WAL. La copia en línea de SQLite no.
    const escribiendo = setInterval(
      () => db.prepare("UPDATE settings SET value = value WHERE key = 'hotel_name'").run(), 1);
    let copia;
    try { copia = (await backup({ quiet: true })).archivo; } finally { clearInterval(escribiendo); }

    const c = new Database(copia, { readonly: true });
    try {
      assert.equal(c.pragma('integrity_check')[0].integrity_check, 'ok');
      assert.equal(c.prepare('SELECT COUNT(*) n FROM rooms').get().n, 155);
      assert.equal(
        c.prepare('SELECT COUNT(*) n FROM movements').get().n,
        one('SELECT COUNT(*) n FROM movements').n,
        'el historial debe viajar completo');
      assert.ok(
        c.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'trigger'").get().n > 0,
        'los disparadores de inmutabilidad viajan con la copia');
    } finally { c.close(); }
  });

  test('la rotación conserva sólo los respaldos pedidos', async () => {
    for (let i = 0; i < 3; i += 1) await backup({ quiet: true, keep: 2 });
    const dir = path.join(TMP, 'backups');
    const copias = fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite'));
    assert.ok(copias.length <= 2, `quedaron ${copias.length} respaldos`);
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
      comment: 'La TV no da señal.', guestPresent: 'no',
    });
    // El reporte no manda a un estado de su área —eso ya no existe—, pero sí
    // saca de la venta a la habitación que estaba disponible.
    assert.equal(res.room.status_code, 'FUERA_SERVICIO');
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
      comment: 'El panel táctil no responde.', guestPresent: 'no',
    });
    const n = one('SELECT * FROM notifications WHERE movement_id = @id', { id: res.primaryId });
    assert.ok(n, 'debe generarse una notificación');
    assert.deepEqual(destinatarios(n.id), ['AMA', 'SIS']);
  });

  test('el cierre también avisa a ambos', () => {
    const room = getRoomByNumber('717');
    recordMovement({ roomId: room.id, user: user('amadellaves'), movementTypeCode: 'SYS_REPORT', comment: 'WiFi caído.', guestPresent: 'no' });
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
      comment: 'Fuga en el lavabo.', guestPresent: 'no',
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
      comment: 'Extensión sin tono.', guestPresent: 'no',
    });
    const n = one('SELECT * FROM notifications WHERE movement_id = @id', { id: res.primaryId });
    assert.deepEqual(destinatarios(n.id), ['SIS'], 'sin copia, sólo el área destino');
    setSettingValue('notify_housekeeping_copy', '1', null);
  });
});

describe('No se libera una habitación con un pendiente abierto', () => {
  const mov = (numero, quien, code, comentario) => recordMovement({
    roomId: getRoomByNumber(String(numero)).id, user: user(quien),
    movementTypeCode: code, comment: comentario,
  });
  const estado = (numero, quien, code) => recordMovement({
    roomId: getRoomByNumber(String(numero)).id, user: user(quien),
    statusCode: code, comment: 'Cambio manual de estado.',
  });
  /** Deja la habitación como la encuentra la camarista: de salida y sucia. */
  const deSalida = (numero) => estado(numero, 'supervisor', 'SALIDA');
  const reporte = (numero, quien, code, comentario) => recordMovement({
    roomId: getRoomByNumber(String(numero)).id, user: user(quien),
    movementTypeCode: code, comment: comentario, guestPresent: 'no',
  });

  test('el ciclo de limpieza sin pendientes llega hasta liberar', () => {
    deSalida(608);
    mov(608, 'amadellaves', 'CLEAN_DONE');
    mov(608, 'amadellaves', 'INSPECTION');
    mov(608, 'supervisor', 'RELEASE', 'Habitación lista.');
    assert.equal(getRoomByNumber('608').counts_ready, 1);
  });

  test('un reporte a Sistemas impide liberar', () => {
    reporte(610, 'amadellaves', 'SYS_REPORT', 'Televisión sin señal.');
    assert.throws(() => mov(610, 'supervisor', 'RELEASE', 'Se intenta cerrar.'),
      (e) => e instanceof MovementError && e.status === 409 && /no puede quedar como/.test(e.message));
    // El mensaje dice qué falta, no sólo que no se puede.
    try { mov(610, 'supervisor', 'RELEASE', 'Se intenta cerrar.'); } catch (e) {
      assert.match(e.message, /610/);
      assert.match(e.message, /Sistemas/);
      assert.match(e.message, /Televisión sin señal/);
    }
  });

  test('cerrado el reporte, la habitación se libera con normalidad', () => {
    mov(610, 'sistemas', 'SYS_DONE', 'Decodificador reemplazado.');
    mov(610, 'supervisor', 'RELEASE', 'Habitación lista.');
    assert.equal(getRoomByNumber('610').counts_ready, 1);
  });

  test('el pendiente no estorba el resto del ciclo', () => {
    // Limpiar, comentar y reportar siguen siendo posibles: lo único vedado es
    // devolver la habitación al servicio. Con el huésped en casa, además, la
    // limpieza la deja "Ocupado limpio", no a la venta.
    estado(611, 'supervisor', 'OCUPADO_SUCIO');
    reporte(611, 'amadellaves', 'MAINT_REPORT', 'Chapa floja.');
    mov(611, 'amadellaves', 'CLEAN_DONE');
    mov(611, 'amadellaves', 'NOTE', 'Queda pendiente la chapa.');
    assert.equal(getRoomByNumber('611').status_code, 'OCUPADO_LIMPIO');
  });

  test('un campo de Mantenimiento en falla también impide liberar', () => {
    deSalida(612);
    recordMovement({
      roomId: getRoomByNumber('612').id, user: user('mantenimiento'),
      details: [{ fieldCode: 'plomeria', value: 'Falla' }],
    });
    assert.throws(() => mov(612, 'supervisor', 'RELEASE', 'Va.'),
      (e) => /Plomería/.test(e.message));
    recordMovement({
      roomId: getRoomByNumber('612').id, user: user('mantenimiento'),
      details: [{ fieldCode: 'plomeria', value: 'OK' }],
    });
    mov(612, 'supervisor', 'RELEASE', 'Ya quedó.');
    assert.equal(getRoomByNumber('612').counts_ready, 1);
  });

  test('un pendiente de Ama de Llaves no impide liberar', () => {
    // Sólo bloquean las categorías marcadas con `blocks_release`, hoy
    // Mantenimiento y Sistemas. Los blancos los resuelve la propia camarista.
    deSalida(613);
    recordMovement({
      roomId: getRoomByNumber('613').id, user: user('amadellaves'),
      details: [{ fieldCode: 'blancos', value: 'Incompleto' }],
    });
    mov(613, 'supervisor', 'RELEASE', 'Se repone en el turno.');
    assert.equal(getRoomByNumber('613').counts_ready, 1);
  });

  test('el cambio manual de estado no es una puerta trasera', () => {
    reporte(614, 'amadellaves', 'SYS_REPORT', 'Caja fuerte trabada.');
    assert.throws(() => estado(614, 'supervisor', 'DISPONIBLE_LIMPIO'),
      (e) => e instanceof MovementError && e.status === 409);
    // Un estado que no devuelve al servicio sí se puede poner.
    estado(614, 'supervisor', 'OCUPADO_SUCIO');
    assert.equal(getRoomByNumber('614').status_code, 'OCUPADO_SUCIO');
  });

  test('en bloque: una habitación con pendiente detiene el lote entero', () => {
    deSalida(615);
    deSalida(616);
    reporte(616, 'amadellaves', 'MAINT_REPORT', 'Regadera goteando.');
    const ids = ['615', '616'].map((n) => getRoomByNumber(n).id);
    assert.throws(
      () => recordBulkMovement({ roomIds: ids, user: user('supervisor'), movementTypeCode: 'RELEASE', comment: 'Piso listo.' }),
      (e) => /616/.test(e.message) && /no puede quedar como/.test(e.message));
    assert.equal(getRoomByNumber('615').status_code, 'SALIDA', 'el lote es todo o nada');
  });

  test('el mensaje del lote no repite el número de la habitación', () => {
    try {
      recordBulkMovement({
        roomIds: [getRoomByNumber('616').id], user: user('supervisor'),
        movementTypeCode: 'RELEASE', comment: 'Va.',
      });
      assert.fail('debería rechazarse');
    } catch (e) {
      assert.equal((e.message.match(/616/g) ?? []).length, 1, e.message);
    }
  });
});

describe('Una falla saca la habitación del servicio', () => {
  const campo = (numero, quien, code, valor, extra = {}) => recordMovement({
    roomId: getRoomByNumber(String(numero)).id, user: user(quien),
    details: [{ fieldCode: code, value: valor }], ...extra,
  });
  const mov = (numero, quien, code, comentario) => recordMovement({
    roomId: getRoomByNumber(String(numero)).id, user: user(quien),
    movementTypeCode: code, comment: comentario,
  });

  test('marcar un campo de Mantenimiento en falla retira la habitación de la venta', () => {
    assert.equal(getRoomByNumber('617').counts_ready, 1, 'parte disponible');
    campo(617, 'mantenimiento', 'plomeria', 'Falla');
    assert.equal(getRoomByNumber('617').status_code, 'FUERA_SERVICIO');
  });

  test('el retiro queda en el historial como un movimiento propio', () => {
    const movs = all(
      "SELECT action, old_status_name, new_status_name FROM movements WHERE room_number = '617' ORDER BY id");
    const retiro = movs.find((m) => /Retirada del servicio/.test(m.action));
    assert.ok(retiro, 'debe existir un movimiento que explique el cambio de estado');
    // Los nombres se comparan contra el catálogo: una prueba anterior renombra
    // un estado a propósito, y el historial guarda el nombre del momento.
    const nombre = (code) => one('SELECT name FROM room_statuses WHERE code = @code', { code }).name;
    assert.equal(retiro.old_status_name, nombre('DISPONIBLE_LIMPIO'));
    assert.equal(retiro.new_status_name, nombre('FUERA_SERVICIO'));
  });

  test('la falla de Sistemas la retira igual que la de Mantenimiento', () => {
    campo(618, 'sistemas', 'wifi', 'Sin servicio');
    assert.equal(getRoomByNumber('618').status_code, 'FUERA_SERVICIO');
  });

  test('corregir el campo no devuelve sola la habitación: hay que liberarla', () => {
    campo(617, 'mantenimiento', 'plomeria', 'OK');
    assert.equal(getRoomByNumber('617').status_code, 'FUERA_SERVICIO');
    mov(617, 'supervisor', 'RELEASE', 'Reparada y revisada.');
    assert.equal(getRoomByNumber('617').counts_ready, 1);
  });

  test('un campo de Ama de Llaves no retira la habitación de la venta', () => {
    campo(619, 'amadellaves', 'blancos', 'Incompleto');
    assert.equal(getRoomByNumber('619').counts_ready, 1);
  });

  test('una habitación que ya no estaba a la venta no cambia de estado', () => {
    recordMovement({ roomId: getRoomByNumber('620').id, user: user('supervisor'), statusCode: 'SALIDA' });
    campo(620, 'mantenimiento', 'hvac', 'Falla');
    assert.equal(getRoomByNumber('620').status_code, 'SALIDA',
      'sólo se retira a la que estaba en servicio; el resto sigue su ciclo');
  });

  test('pedir un estado de servicio mientras se reporta la falla se rechaza', () => {
    recordMovement({ roomId: getRoomByNumber('622').id, user: user('supervisor'), statusCode: 'SALIDA' });
    assert.throws(
      () => campo(622, 'mantenimiento', 'plomeria', 'Falla', {
        statusCode: 'DISPONIBLE_LIMPIO', comment: 'Contradictorio.',
      }),
      (e) => e instanceof MovementError && e.status === 409 && /en este mismo registro se reporta/.test(e.message));
    assert.equal(getRoomByNumber('622').status_code, 'SALIDA', 'no debe quedar nada a medias');
    assert.equal(
      one("SELECT value v FROM room_details rd JOIN fields f ON f.id = rd.field_id WHERE rd.room_id = @r AND f.code = 'plomeria'",
        { r: getRoomByNumber('622').id })?.v ?? 'OK',
      'OK', 'el campo tampoco se guardó');
  });

  test('el retiro no exige permiso de cambiar estados', () => {
    // Lo provoca el sistema al detectar la falla, no lo pide el usuario.
    // Quien reporta puede no tener `room.status`, y dejar la habitación a la
    // venta sería lo inseguro.
    const jefe = user('mantenimiento');
    assert.ok(jefe.permissions.includes('room.edit'));
    const antes = getRoomByNumber('1002');
    assert.equal(antes.counts_ready, 1);
    recordMovement({
      roomId: antes.id,
      user: { ...jefe, permissions: jefe.permissions.filter((p) => p !== 'room.status') },
      details: [{ fieldCode: 'cerraduras', value: 'Falla' }],
    });
    assert.equal(getRoomByNumber('1002').status_code, 'FUERA_SERVICIO');
  });
});

describe('Incidencias abiertas por reporte', () => {
  const abiertas = () => stats.overview().incidenciasAbiertas;
  const mov = (numero, quien, code, comentario) => recordMovement({
    roomId: getRoomByNumber(String(numero)).id, user: user(quien),
    movementTypeCode: code, comment: comentario, guestPresent: 'no',
  });

  test('un reporte a Sistemas cuenta como incidencia abierta hasta que se cierra', () => {
    const antes = abiertas();
    mov(601, 'amadellaves', 'SYS_REPORT', 'Televisión sin señal.');
    assert.equal(abiertas(), antes + 1, 'el reporte debe contar en el indicador');
    mov(601, 'sistemas', 'SYS_DONE', 'Decodificador reemplazado.');
    assert.equal(abiertas(), antes, 'completar el trabajo debe cerrarla');
  });

  test('cerrar en un área no cierra lo pendiente de otra', () => {
    const antes = abiertas();
    mov(602, 'amadellaves', 'MAINT_REPORT', 'Fuga en el lavabo.');
    mov(602, 'sistemas', 'SYS_DONE', 'Trabajo de Sistemas, ajeno a la fuga.');
    assert.equal(abiertas(), antes + 1, 'la fuga sigue pendiente');
    mov(602, 'mantenimiento', 'MAINT_DONE', 'Empaque reemplazado.');
    assert.equal(abiertas(), antes);
  });

  test('"Liberar habitación" cierra todo lo pendiente de esa habitación', () => {
    const antes = abiertas();
    mov(603, 'amadellaves', 'DAMAGE', 'Espejo roto.');
    mov(603, 'amadellaves', 'DISCREPANCY', 'Recepción la da por ocupada y está vacía.');
    assert.equal(abiertas(), antes + 2, 'dos reportes, dos incidencias');
    mov(603, 'supervisor', 'RELEASE', 'Todo resuelto.');
    assert.equal(abiertas(), antes);
  });

  test('devolver la habitación al servicio también cierra lo pendiente', () => {
    // Se usa un daño (categoría Ama de Llaves), no un reporte a Mantenimiento
    // o a Sistemas: esas áreas impiden devolver la habitación al servicio, así
    // que con ellas este camino no existe.
    const room = getRoomByNumber('604');
    recordMovement({ roomId: room.id, user: user('supervisor'), statusCode: 'SALIDA' });
    const antes = abiertas();
    mov(604, 'amadellaves', 'DAMAGE', 'Cabecera rayada.');
    assert.equal(abiertas(), antes + 1);
    recordMovement({
      roomId: room.id, user: user('supervisor'), statusCode: 'DISPONIBLE_LIMPIO',
      comment: 'Se resolvió sin registrar la acción.',
    });
    assert.equal(abiertas(), antes, 'si volvió a estar lista, no queda nada pendiente');
  });

  test('una observación no cierra nada', () => {
    const antes = abiertas();
    mov(605, 'amadellaves', 'SYS_REPORT', 'Teléfono mudo.');
    mov(605, 'amadellaves', 'NOTE', 'Sigo esperando a Sistemas.');
    assert.equal(abiertas(), antes + 1, 'comentar no resuelve');
    mov(605, 'sistemas', 'SYS_DONE', 'Extensión reprogramada.');
  });

  test('un campo en falla se cuenta una sola vez, no dos', () => {
    const antes = abiertas();
    recordMovement({
      roomId: getRoomByNumber('606').id, user: user('mantenimiento'),
      details: [{ fieldCode: 'plomeria', value: 'Falla' }],
    });
    // El cambio de campo genera un movimiento con is_incident = 1 Y deja el
    // campo en valor de incidencia: debe contar como UNA.
    assert.equal(abiertas(), antes + 1);
    recordMovement({
      roomId: getRoomByNumber('606').id, user: user('mantenimiento'),
      details: [{ fieldCode: 'plomeria', value: 'OK' }],
    });
    assert.equal(abiertas(), antes);
  });

  test('la habitación reportada aparece con su incidencia en "Requiere atención"', () => {
    mov(608, 'amadellaves', 'SYS_REPORT', 'Caja fuerte bloqueada.');
    const fila = stats.attention({ limit: 400 }).items.find((i) => i.number === '608');
    assert.ok(fila, 'debe aparecer en la lista');
    assert.equal(fila.incidentCount, 1);
    assert.ok(fila.reasons.some((r) => r.code === 'incidencia'));
  });
});

describe('Estados de Arpón y el dato del huésped', () => {
  // El CDH usa los mismos estados que el PMS del hotel, y lo que hacía falta
  // saber de verdad —si el huésped estará dentro cuando suba Mantenimiento o
  // Sistemas— viaja con el reporte, no como un estado de la habitación.

  test('el catálogo es el de Arpón, y sólo ése', () => {
    const activos = all('SELECT code FROM room_statuses WHERE active = 1 ORDER BY sort_order')
      .map((s) => s.code);
    assert.deepEqual(activos, [
      'DISPONIBLE_LIMPIO', 'ENTRADA_NUEVA', 'OCUPADO_LIMPIO',
      'OCUPADO_SUCIO', 'SALIDA', 'DISCREPANCIA', 'FUERA_SERVICIO',
    ]);
  });

  test('la limpieza lleva a un sitio distinto según de dónde venga', () => {
    // Es la razón de `clean_status_id`: "Limpieza terminada" no puede apuntar
    // a un único destino sin mentir en la mitad de los casos.
    const salida = getRoomByNumber('501');
    recordMovement({ roomId: salida.id, user: user('supervisor'), statusCode: 'SALIDA' });
    const limpia = recordMovement({ roomId: salida.id, user: user('amadellaves'), movementTypeCode: 'CLEAN_DONE' });
    assert.equal(limpia.room.status_code, 'DISPONIBLE_LIMPIO', 'el huésped se fue: queda a la venta');

    const enCasa = getRoomByNumber('502');
    recordMovement({ roomId: enCasa.id, user: user('supervisor'), statusCode: 'OCUPADO_SUCIO' });
    const atendida = recordMovement({ roomId: enCasa.id, user: user('amadellaves'), movementTypeCode: 'CLEAN_DONE' });
    assert.equal(atendida.room.status_code, 'OCUPADO_LIMPIO', 'el huésped se queda: no vuelve a la venta');
  });

  test('no se puede dar por limpia una habitación que no esperaba limpieza', () => {
    const room = getRoomByNumber('503');
    assert.equal(room.status_code, 'DISPONIBLE_LIMPIO');
    assert.throws(
      () => recordMovement({ roomId: room.id, user: user('amadellaves'), movementTypeCode: 'CLEAN_DONE' }),
      (e) => e.status === 409 && /no espera limpieza/.test(e.message));
  });

  test('el reporte lleva si el huésped estará en la habitación', () => {
    const room = getRoomByNumber('504');
    const res = recordMovement({
      roomId: room.id, user: user('amadellaves'), movementTypeCode: 'SYS_REPORT',
      comment: 'La TV no enciende.', guestPresent: 'no', guestPresent: 'si',
    });
    const m = one('SELECT * FROM movements WHERE id = @id', { id: res.primaryId });
    assert.equal(m.guest_present, 'si');
    // El dato viaja con el reporte; lo que mueve el estado es que la
    // habitación estuviera a la venta con un pendiente abierto.
    assert.equal(res.room.status_code, 'FUERA_SERVICIO');
  });

  test('un reporte sin ese dato se rechaza', () => {
    const room = getRoomByNumber('505');
    assert.throws(
      () => recordMovement({ roomId: room.id, user: user('amadellaves'),
        movementTypeCode: 'MAINT_REPORT', comment: 'Fuga en el lavabo.' }),
      (e) => e.status === 400 && /si el huésped estará/.test(e.message));
    assert.throws(
      () => recordMovement({ roomId: room.id, user: user('amadellaves'), movementTypeCode: 'MAINT_REPORT',
        comment: 'Fuga en el lavabo.', guestPresent: 'quizá' }),
      (e) => e.status === 400 && /Valor inválido/.test(e.message));
  });

  test('la notificación al área destino lo dice primero', () => {
    const room = getRoomByNumber('514');
    const res = recordMovement({
      roomId: room.id, user: user('amadellaves'), movementTypeCode: 'MAINT_REPORT',
      comment: 'Regadera goteando.', guestPresent: 'si',
    });
    const n = one('SELECT * FROM notifications WHERE movement_id = @id', { id: res.primaryId });
    assert.match(n.body, /^El huésped estará en la habitación\./,
      'quien sube necesita saberlo antes que el detalle');
    assert.match(n.body, /Regadera goteando/);
  });

  test('las acciones que no lo preguntan no lo guardan', () => {
    const room = getRoomByNumber('506');
    const res = recordMovement({ roomId: room.id, user: user('amadellaves'),
      movementTypeCode: 'NOTE', comment: 'Sin novedad.', guestPresent: 'si' });
    assert.equal(one('SELECT guest_present FROM movements WHERE id = @id', { id: res.primaryId }).guest_present, null,
      'el dato sólo tiene sentido donde se pregunta');
  });

  test('el reporte sigue impidiendo que la habitación quede a la venta', () => {
    // El reporte ya no mueve el estado; la garantía la da la incidencia abierta.
    const room = getRoomByNumber('508');
    recordMovement({ roomId: room.id, user: user('amadellaves'), movementTypeCode: 'SYS_REPORT',
      comment: 'Caja fuerte trabada.', guestPresent: 'no', guestPresent: 'no' });
    assert.throws(
      () => recordMovement({ roomId: room.id, user: user('supervisor'), statusCode: 'DISPONIBLE_LIMPIO' }),
      (e) => e.status === 409 && /sin cerrar/.test(e.message));
  });

  test('un lote omite las habitaciones que no esperaban limpieza', () => {
    const ids = ['510', '512', '513'].map((n) => getRoomByNumber(n).id);
    recordMovement({ roomId: ids[0], user: user('supervisor'), statusCode: 'SALIDA' });
    const r = recordBulkMovement({
      roomIds: ids, user: user('amadellaves'), movementTypeCode: 'CLEAN_DONE',
    });
    assert.equal(r.aplicadas.length, 1, 'sólo la que esperaba limpieza');
    assert.equal(r.omitidas.length, 2);
    assert.ok(r.omitidas.every((o) => o.motivo === 'no esperaba limpieza'));
  });
});

describe('Centro de solicitudes de limpieza', () => {
  const pedir = (numero, quien, priority, note = null) => cleaning.requestCleaning({
    roomId: getRoomByNumber(String(numero)).id, user: user(quien), priorityCode: priority, note,
  });
  const cola = () => cleaning.listRequests({ status: 'pendiente' });

  test('Recepción pide, y la solicitud queda en cola con su movimiento', () => {
    const room = getRoomByNumber('901');
    const r = pedir(901, 'recepcion', 'ALTA', 'El huésped llega a las 3.');
    assert.equal(r.creada, true);
    assert.equal(r.request.status, 'pendiente');
    assert.equal(r.request.priority_code, 'ALTA');
    assert.equal(r.request.requested_by_name, 'Recepción Turno A');

    // El movimiento vive en el expediente de la habitación, como todo.
    const m = one('SELECT * FROM movements WHERE id = @id', { id: r.request.movement_id });
    assert.equal(m.action_code, 'CLEAN_REQUEST');
    assert.equal(m.room_id, room.id);
    assert.match(m.comment, /Alta/);
    assert.match(m.comment, /llega a las 3/);
  });

  test('avisa a Ama de Llaves, que es quien la atiende', () => {
    const r = pedir(902, 'recepcion', 'MEDIA');
    const n = one('SELECT * FROM notifications WHERE movement_id = @id', { id: r.request.movement_id });
    assert.ok(n, 'una solicitud sin aviso no llega a nadie');
    const destinos = all(`
      SELECT d.code FROM notification_recipients nr
        JOIN departments d ON d.id = nr.department_id
       WHERE nr.notification_id = @id`, { id: n.id }).map((x) => x.code);
    assert.ok(destinos.includes('AMA'), `debía avisar a Ama de Llaves: ${destinos.join(', ')}`);
  });

  test('pedir dos veces no duplica el trabajo: sube la prioridad o no cambia nada', () => {
    pedir(903, 'recepcion', 'BAJA');
    const subida = pedir(903, 'recepcion', 'URGENTE', 'El huésped está en el lobby.');
    assert.equal(subida.creada, false);
    assert.equal(subida.elevada, true);
    assert.equal(subida.request.priority_code, 'URGENTE');

    const otra = pedir(903, 'amadellaves', 'MEDIA');
    assert.equal(otra.elevada, false, 'una prioridad menor no rebaja la que ya había');
    assert.equal(otra.request.priority_code, 'URGENTE');

    assert.equal(
      one("SELECT COUNT(*) n FROM cleaning_requests WHERE room_id = @id AND status = 'pendiente'",
        { id: getRoomByNumber('903').id }).n, 1, 'una habitación, una sola solicitud en cola');
  });

  test('la cola pone primero lo urgente y, a igual prioridad, lo que lleva más esperando', () => {
    const pendientes = cola().filter((s) => ['901', '902', '903'].includes(s.room_number));
    assert.deepEqual(pendientes.map((s) => s.room_number), ['903', '901', '902'],
      'urgente, luego alta, luego media');
  });

  test('limpiar la habitación cierra la solicitud sola, sin un movimiento de más', () => {
    const room = getRoomByNumber('904');
    recordMovement({ roomId: room.id, user: user('supervisor'), statusCode: 'SALIDA' });
    pedir(904, 'recepcion', 'ALTA');
    const antes = one('SELECT COUNT(*) n FROM movements WHERE room_id = @id', { id: room.id }).n;

    const limpia = recordMovement({ roomId: room.id, user: user('amadellaves'), movementTypeCode: 'CLEAN_DONE' });
    assert.ok(limpia.cleaningRequestClosed, 'la limpieza debe cerrar la solicitud');

    const s = one("SELECT * FROM cleaning_requests WHERE room_id = @id ORDER BY id DESC LIMIT 1", { id: room.id });
    assert.equal(s.status, 'atendida');
    assert.equal(s.closed_by_name, 'Jefa de Ama de Llaves');
    assert.equal(s.closed_movement_id, limpia.primaryId);
    assert.equal(one('SELECT COUNT(*) n FROM movements WHERE room_id = @id', { id: room.id }).n, antes + 1,
      'el movimiento de la limpieza ya cuenta lo ocurrido: no hace falta otro');
  });

  test('cancelar exige un motivo y lo deja escrito', () => {
    const r = pedir(905, 'recepcion', 'BAJA');
    assert.throws(
      () => cleaning.cancelRequest({ id: r.request.id, user: user('recepcion') }),
      (e) => e.status === 400 && /necesita un motivo/.test(e.message));

    const cancelada = cleaning.cancelRequest({
      id: r.request.id, user: user('recepcion'), reason: 'El huésped ya no llega.',
    });
    assert.equal(cancelada.status, 'cancelada');
    assert.equal(cancelada.closed_reason, 'El huésped ya no llega.');
    assert.equal(
      one('SELECT action_code FROM movements WHERE id = @id', { id: cancelada.closed_movement_id }).action_code,
      'CLEAN_REQUEST_CANCEL');
  });

  test('una solicitud cerrada no se cierra dos veces', () => {
    const r = pedir(906, 'recepcion', 'MEDIA');
    cleaning.attendRequest({ id: r.request.id, user: user('amadellaves') });
    assert.throws(
      () => cleaning.attendRequest({ id: r.request.id, user: user('amadellaves') }),
      (e) => e.status === 409 && /ya está atendida/.test(e.message));
  });

  test('sin el permiso no se solicita limpieza', () => {
    const sinPermiso = {
      ...user('amadellaves'),
      permissions: user('amadellaves').permissions.filter((p) => p !== 'cleaning.request'),
    };
    assert.throws(
      () => cleaning.requestCleaning({ roomId: getRoomByNumber('908').id, user: sinPermiso, priorityCode: 'BAJA' }),
      (e) => e.status === 403);
  });

  test('entregar una habitación limpia la saca de la venta', () => {
    const room = getRoomByNumber('910');
    assert.equal(room.counts_ready, 1, 'parte limpia y libre');
    const r = recordMovement({ roomId: room.id, user: user('recepcion'), movementTypeCode: 'DELIVER',
      comment: 'A nombre de Pérez.' });
    assert.equal(r.room.status_code, 'ENTRADA_NUEVA');
    assert.equal(r.room.counts_ready, 0, 'entregada deja de contar como disponible');
  });

  test('la entrega avisa de que hay que repetirla en el PMS', () => {
    const aviso = cleaning.pmsNotice();
    assert.match(aviso, /Arpón Enterprise/);
    const entrega = one("SELECT warns_pms FROM movement_types WHERE code = 'DELIVER'");
    assert.equal(entrega.warns_pms, 1, 'la acción tiene que pedir el aviso');
  });

  test('el resumen cuenta lo pendiente y nombra lo más urgente', () => {
    const resumen = cleaning.pendingSummary();
    assert.equal(resumen.total, cola().length);
    assert.equal(resumen.masUrgente.name, 'Urgente');
    assert.equal(resumen.porPrioridad[0].code, 'URGENTE', 'el reparto va de más urgente a menos');
  });
});

describe('Cambios en bloque', () => {
  const idsDe = (...numeros) => numeros.map((n) => getRoomByNumber(String(n)).id);
  /** Deja las habitaciones como las encuentra la camarista. */
  const deSalida = (...numeros) => {
    for (const id of idsDe(...numeros)) {
      recordMovement({ roomId: id, user: user('supervisor'), statusCode: 'SALIDA' });
    }
    return idsDe(...numeros);
  };

  test('una acción sobre varias habitaciones deja un movimiento en cada una', () => {
    const ids = deSalida(1101, 1102, 1103);
    const antes = one('SELECT COUNT(*) n FROM movements').n;
    const r = recordBulkMovement({
      roomIds: ids, user: user('amadellaves'), movementTypeCode: 'CLEAN_DONE',
      comment: 'Ronda matutina del piso 10.',
    });
    assert.equal(r.aplicadas.length, 3);
    assert.equal(one('SELECT COUNT(*) n FROM movements').n - antes, 3);

    for (const id of ids) {
      const m = one('SELECT * FROM movements WHERE room_id = @id ORDER BY id DESC LIMIT 1', { id });
      assert.equal(m.action_code, 'CLEAN_DONE');
      assert.equal(m.new_status_id,
        one("SELECT id FROM room_statuses WHERE code = 'DISPONIBLE_LIMPIO'").id);
      assert.equal(m.comment, 'Ronda matutina del piso 10.');
      assert.ok(m.user_name && m.local_time && m.timezone, 'el sello del servidor no cambia por ser un lote');
    }
  });

  test('cada habitación conserva su propio lote: el historial no se comparte', () => {
    const ids = deSalida(1106, 1107);
    const r = recordBulkMovement({
      roomIds: ids, user: user('amadellaves'), movementTypeCode: 'CLEAN_DONE',
    });
    const lotes = new Set(r.aplicadas.map((a) => a.batchId));
    assert.equal(lotes.size, 2, 'dos habitaciones, dos movimientos distintos');
  });

  test('el lote es todo o nada: si una habitación falla, ninguna cambia', () => {
    const ids = idsDe(1008, 1010);
    const previos = ids.map((id) => one('SELECT status_id FROM rooms WHERE id = @id', { id }).status_id);
    const total = one('SELECT COUNT(*) n FROM movements').n;

    // MAINT_REPORT exige comentario: el lote entero debe revertirse.
    assert.throws(
      () => recordBulkMovement({ roomIds: ids, user: user('amadellaves'), movementTypeCode: 'MAINT_REPORT' }),
      (e) => e instanceof MovementError && /comentario/i.test(e.message));

    assert.equal(one('SELECT COUNT(*) n FROM movements').n, total, 'no debe quedar ningún movimiento suelto');
    ids.forEach((id, i) => {
      assert.equal(one('SELECT status_id FROM rooms WHERE id = @id', { id }).status_id, previos[i]);
    });
  });

  test('el error nombra la habitación que lo provocó', () => {
    assert.throws(
      () => recordBulkMovement({ roomIds: idsDe(1011), user: user('amadellaves'), movementTypeCode: 'MAINT_REPORT' }),
      (e) => /Habitación 1011:/.test(e.message));
  });

  test('las habitaciones que ya están en el estado destino se omiten, no fallan', () => {
    const ids = idsDe(1012, 1014);
    recordBulkMovement({ roomIds: [ids[0]], user: user('supervisor'), statusCode: 'FUERA_SERVICIO', comment: 'Obra.' });
    const r = recordBulkMovement({ roomIds: ids, user: user('supervisor'), statusCode: 'FUERA_SERVICIO' });
    assert.equal(r.aplicadas.length, 1);
    assert.equal(r.omitidas.length, 1);
    assert.match(r.omitidas[0].motivo, /ya estaba/);
  });

  test('el lote respeta el tope configurado', () => {
    const { setSettingValue } = settingsMod;
    setSettingValue('bulk_max_rooms', '2', null);
    assert.throws(
      () => recordBulkMovement({ roomIds: idsDe(1015, 1016, 1017), user: user('amadellaves'), movementTypeCode: 'CLEAN_DONE' }),
      (e) => /hasta 2 habitaciones/.test(e.message));
    setSettingValue('bulk_max_rooms', '40', null);
  });

  test('el lote respeta los permisos igual que un cambio individual', () => {
    assert.throws(
      () => recordBulkMovement({ roomIds: deSalida(1018, 1019), user: user('recepcion'), movementTypeCode: 'CLEAN_DONE' }),
      (e) => e instanceof MovementError && e.status === 403);
  });

  test('el lote deja una entrada de auditoría que lo identifica como tal', () => {
    const r = recordBulkMovement({
      roomIds: deSalida(1020, 1022), user: user('amadellaves'), movementTypeCode: 'CLEAN_DONE',
    });
    const a = one("SELECT * FROM audit_log WHERE action = 'bulk_movement' ORDER BY id DESC LIMIT 1");
    assert.equal(a.entity_id, r.bulkId);
    const despues = JSON.parse(a.after_json);
    assert.deepEqual(Object.keys(despues.estados).sort(), ['1020', '1022']);
    assert.ok(JSON.parse(a.before_json).estados['1020'], 'la auditoría guarda el estado anterior de cada habitación');
  });

  test('un lote vacío o sin acción se rechaza', () => {
    assert.throws(() => recordBulkMovement({ roomIds: [], user: user('amadellaves'), movementTypeCode: 'CLEAN_DONE' }),
      (e) => /al menos una habitación/.test(e.message));
    assert.throws(() => recordBulkMovement({ roomIds: idsDe(1001), user: user('amadellaves') }),
      (e) => /Elija una acción o un estado/.test(e.message));
  });
});
