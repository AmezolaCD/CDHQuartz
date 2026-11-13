// Pruebas de la lógica pura de la entrada del PMS. No tocan base de datos:
// la regla de precedencia es lo que no se puede equivocar y se prueba sola.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  roomNumberFromKey, decidePrecedence, epochFromPmsTimestamp, isStalePmsEvent,
  pmsComment, ESTADOS_PROPIOS_DEL_CDH, PMS_MOVEMENT_TYPE,
  pmsEventKey, isDuplicatePmsEvent, VENTANA_DUPLICADO_MS,
} from '../server/lib/pms.js';
import { ROOM_STATUSES, MOVEMENT_TYPES, FLOOR_MAP } from '../server/db/catalog.js';

/** Los cinco que Arpón y el CDH comparten. */
const COMPARTIDOS = ['DISPONIBLE_LIMPIO', 'ENTRADA_NUEVA', 'OCUPADO_LIMPIO', 'OCUPADO_SUCIO', 'SALIDA'];

describe('El catálogo sostiene la regla', () => {
  test('los estados que nombra la regla existen en el catálogo', () => {
    const codigos = ROOM_STATUSES.map((s) => s.code);
    for (const c of [...COMPARTIDOS, ...ESTADOS_PROPIOS_DEL_CDH]) {
      assert.ok(codigos.includes(c), `el catálogo ya no tiene el estado ${c}`);
    }
    // Si el catálogo gana un estado, hay que decidir de quién es: callarlo lo
    // dejaría por omisión del lado de Arpón.
    assert.deepEqual(
      codigos.slice().sort(),
      [...COMPARTIDOS, ...ESTADOS_PROPIOS_DEL_CDH].sort(),
      'hay un estado nuevo en el catálogo que la regla de precedencia no contempla',
    );
  });

  test('el tipo de movimiento del PMS existe y es de sistema', () => {
    const t = MOVEMENT_TYPES.find((m) => m.code === PMS_MOVEMENT_TYPE);
    assert.ok(t, `falta el tipo de movimiento ${PMS_MOVEMENT_TYPE}`);
    assert.equal(t.is_system, 1);
    assert.equal(t.target_status, null, 'el estado lo decide el evento, no el tipo');
    // Arpón puede mover el estado, pero no dar por cerrado un pendiente que
    // abrió alguien de la casa.
    assert.ok(!t.closes_incident, 'un evento del PMS no debe cerrar pendientes');
    assert.ok(!t.closes_cleaning_request, 'un evento del PMS no debe cerrar solicitudes');
  });
});

describe('roomKey de Arpón → número del CDH', () => {
  test('quita los ceros a la izquierda', () => {
    assert.deepEqual(roomNumberFromKey('0301'), { ok: true, number: '301' });
    assert.deepEqual(roomNumberFromKey('0415'), { ok: true, number: '415' });
  });

  test('deja igual las de cuatro dígitos', () => {
    assert.deepEqual(roomNumberFromKey('1002'), { ok: true, number: '1002' });
    assert.deepEqual(roomNumberFromKey('1101'), { ok: true, number: '1101' });
  });

  test('las 155 del rack van y vuelven sin perderse', () => {
    const numeros = FLOOR_MAP.flatMap((f) => f.rooms).filter(Boolean).map(String);
    assert.equal(numeros.length, 155);
    for (const n of numeros) {
      const key = n.padStart(4, '0');
      assert.deepEqual(roomNumberFromKey(key), { ok: true, number: n }, `falló ${n}`);
    }
  });

  test('acepta también tres dígitos: el formato de producción no está confirmado', () => {
    // La documentación de GetRoomsByHotel trae claves de tres ("101", "201") y
    // el hotel de pruebas las da de cuatro. Exigir cuatro rechazaría todos los
    // eventos si en producción fueran tres; lo que decide que una clave es
    // buena es que la habitación exista, y de eso se encarga la ruta.
    assert.deepEqual(roomNumberFromKey('415'), { ok: true, number: '415' });
    assert.deepEqual(roomNumberFromKey('301'), { ok: true, number: '301' });
  });

  test('rechaza lo que no sean tres o cuatro dígitos', () => {
    for (const malo of ['00301', '', '  ', 'abcd', '03o1', '0301 ', '10022', '41']) {
      assert.equal(roomNumberFromKey(malo).ok, false, `debió rechazar ${JSON.stringify(malo)}`);
    }
  });

  test('rechaza lo que no sea texto', () => {
    for (const malo of [301, null, undefined, {}, ['0301']]) {
      assert.equal(roomNumberFromKey(malo).ok, false);
    }
  });

  test('"0000" no es una habitación', () => {
    assert.equal(roomNumberFromKey('0000').ok, false);
  });
});

describe('Precedencia: qué estado gana', () => {
  test('entre los cinco compartidos manda Arpón', () => {
    for (const actual of COMPARTIDOS) {
      for (const entra of COMPARTIDOS) {
        if (actual === entra) continue;
        const d = decidePrecedence({ currentStatusCode: actual, incomingStatusCode: entra });
        assert.equal(d.apply, true, `${actual} → ${entra} debió aplicarse`);
      }
    }
  });

  test('un estado propio del CDH no lo pisa ningún aviso del PMS', () => {
    for (const actual of ESTADOS_PROPIOS_DEL_CDH) {
      for (const entra of COMPARTIDOS) {
        const d = decidePrecedence({
          currentStatusCode: actual, incomingStatusCode: entra, pendienteAbierto: true,
        });
        assert.equal(d.apply, false, `${actual} no debió ceder ante ${entra}`);
        assert.equal(d.reason, 'estado_propio_del_cdh');
      }
    }
  });

  test('el caso que decide todo: fuera de servicio no vuelve a la venta', () => {
    const d = decidePrecedence({
      currentStatusCode: 'FUERA_SERVICIO', incomingStatusCode: 'DISPONIBLE_LIMPIO',
      pendienteAbierto: true,
    });
    assert.deepEqual(d, { apply: false, reason: 'estado_propio_del_cdh' });
  });

  test('el mismo estado no genera movimiento', () => {
    const d = decidePrecedence({
      currentStatusCode: 'OCUPADO_SUCIO', incomingStatusCode: 'OCUPADO_SUCIO',
    });
    assert.deepEqual(d, { apply: false, reason: 'sin_cambio' });
  });

  test('sin estado no hay nada que decidir', () => {
    for (const vacio of [undefined, null, '']) {
      const d = decidePrecedence({ currentStatusCode: 'SALIDA', incomingStatusCode: vacio });
      assert.deepEqual(d, { apply: false, reason: 'sin_estado' });
    }
  });

  test('la regla se agota al cerrar el pendiente, aunque el estado no cambie', () => {
    // El caso real: una fuga deja la habitación fuera de servicio; Mantenimiento
    // la repara y cierra su pendiente. Cerrar el pendiente NO cambia el estado
    // —en el CDH hay que liberarla—, así que si la regla mirara sólo el nombre
    // del estado, esa habitación dejaría de escuchar a Arpón para siempre.
    const conPendiente = decidePrecedence({
      currentStatusCode: 'FUERA_SERVICIO', incomingStatusCode: 'OCUPADO_LIMPIO',
      pendienteAbierto: true,
    });
    assert.deepEqual(conPendiente, { apply: false, reason: 'estado_propio_del_cdh' });

    const yaReparada = decidePrecedence({
      currentStatusCode: 'FUERA_SERVICIO', incomingStatusCode: 'OCUPADO_LIMPIO',
      pendienteAbierto: false,
    });
    assert.deepEqual(yaReparada, { apply: true, reason: 'pendiente_cerrado' });
  });

  test('vale igual para Discrepancia', () => {
    assert.equal(decidePrecedence({
      currentStatusCode: 'DISCREPANCIA', incomingStatusCode: 'SALIDA', pendienteAbierto: true,
    }).apply, false);
    assert.equal(decidePrecedence({
      currentStatusCode: 'DISCREPANCIA', incomingStatusCode: 'SALIDA', pendienteAbierto: false,
    }).apply, true);
  });

  test('si quien llama no dice nada, el CDH conserva su estado', () => {
    // El olvido tiene que costar unas horas sin vender, no un huésped metido
    // en una habitación averiada.
    assert.equal(decidePrecedence({
      currentStatusCode: 'FUERA_SERVICIO', incomingStatusCode: 'DISPONIBLE_LIMPIO',
    }).apply, false);
  });

  test('un código desconocido NO se filtra aquí: lo rechaza la puerta de escritura', () => {
    // `recordMovement` es quien puede comprobarlo contra la tabla de estados y
    // ver si además está activo. Esta función decide precedencia, no existencia.
    const d = decidePrecedence({
      currentStatusCode: 'SALIDA', incomingStatusCode: 'ESTADO_QUE_NO_EXISTE',
    });
    assert.equal(d.apply, true);
  });
});

describe('La hora del PMS, que viene sin zona', () => {
  test('una fecha sin zona se lee en la zona del hotel', () => {
    // Arpón manda "09:14" sin decir de dónde; en Tijuana (PST) son 17:14 UTC.
    assert.equal(
      epochFromPmsTimestamp('2026-11-13T09:14:00', 'America/Tijuana'),
      Date.parse('2026-11-13T17:14:00Z'),
    );
  });

  test('respeta el horario de verano', () => {
    // En julio Tijuana va en PDT: una hora menos de desfase.
    assert.equal(
      epochFromPmsTimestamp('2026-07-15T09:14:00', 'America/Tijuana'),
      Date.parse('2026-07-15T16:14:00Z'),
    );
  });

  test('si la fecha trae zona, se respeta', () => {
    assert.equal(
      epochFromPmsTimestamp('2026-11-13T17:14:00Z', 'America/Tijuana'),
      Date.parse('2026-11-13T17:14:00Z'),
    );
    assert.equal(
      epochFromPmsTimestamp('2026-11-13T09:14:00-08:00', 'America/Tijuana'),
      Date.parse('2026-11-13T17:14:00Z'),
    );
  });

  test('acepta la forma con espacio y sin segundos', () => {
    assert.equal(
      epochFromPmsTimestamp('2026-11-13 09:14', 'America/Tijuana'),
      Date.parse('2026-11-13T17:14:00Z'),
    );
  });

  test('lo que no es una fecha devuelve null', () => {
    for (const malo of ['', '   ', 'ayer', '13/11/2026', null, undefined, 42, {}]) {
      assert.equal(epochFromPmsTimestamp(malo, 'America/Tijuana'), null);
    }
  });
});

describe('Eventos rezagados', () => {
  const tz = 'America/Tijuana';

  test('un aviso anterior al último cambio se descarta', () => {
    assert.equal(isStalePmsEvent({
      changedAt: '2026-11-13T08:00:00',               // 16:00Z
      statusChangedAt: '2026-11-13T17:00:00.000Z',
      tz,
    }), true);
  });

  test('un aviso posterior se procesa', () => {
    assert.equal(isStalePmsEvent({
      changedAt: '2026-11-13T09:14:00',               // 17:14Z
      statusChangedAt: '2026-11-13T17:00:00.000Z',
      tz,
    }), false);
  });

  test('comparar sin convertir la zona descartaría un cambio bueno', () => {
    // Éste es el error que la conversión evita: leído como UTC, "09:14"
    // parece anterior a las 16:00Z y el cambio se perdería en silencio.
    const evento = '2026-11-13T09:14:00';
    const actual = '2026-11-13T16:00:00.000Z';        // 08:00 local
    assert.ok(Date.parse(`${evento}Z`) < Date.parse(actual), 'premisa de la trampa');
    assert.equal(isStalePmsEvent({ changedAt: evento, statusChangedAt: actual, tz }), false);
  });

  test('ante la duda no se descarta', () => {
    const actual = '2026-11-13T17:00:00.000Z';
    assert.equal(isStalePmsEvent({ changedAt: null, statusChangedAt: actual, tz }), false);
    assert.equal(isStalePmsEvent({ changedAt: 'ayer', statusChangedAt: actual, tz }), false);
    assert.equal(isStalePmsEvent({ changedAt: '2026-11-13T08:00:00', statusChangedAt: null, tz }), false);
  });
});

describe('El comentario del movimiento', () => {
  test('cuando se aplica, dice qué reportó Arpón y quién', () => {
    const c = pmsComment({
      apply: true, reason: 'aplicado', incomingLabel: 'Ocupado limpio',
      changedBy: 'ama01', changedAt: '2026-11-13T09:14:00',
    });
    assert.match(c, /Arpón/);
    assert.match(c, /ama01/);
    assert.match(c, /Ocupado limpio/);
  });

  test('cuando no se aplica, deja constancia de las dos versiones', () => {
    const c = pmsComment({
      apply: false, reason: 'estado_propio_del_cdh',
      incomingLabel: 'Disponible limpio', currentLabel: 'Fuera de servicio',
      changedBy: 'ama01', changedAt: '2026-11-13T09:14:00',
    });
    assert.match(c, /Disponible limpio/);
    assert.match(c, /Fuera de servicio/);
    assert.match(c, /estado_propio_del_cdh/);
  });

  test('sin firma del PMS sigue siendo legible', () => {
    const c = pmsComment({ apply: true, incomingLabel: 'Salida' });
    assert.match(c, /Arpón reportó "Salida"/);
    assert.ok(!c.includes('()'), 'no debe quedar un paréntesis vacío');
  });
});

describe('Reintentos del webhook, que llegan sin fecha', () => {
  const clave = pmsEventKey({ roomKey: '0301', status: 'SALIDA', changedBy: 'ama01' });

  test('el mismo aviso repetido en la ventana es un reintento', () => {
    assert.equal(isDuplicatePmsEvent({
      key: clave, lastKey: clave, lastEpoch: 1_000_000, now: 1_000_000 + 60_000,
      tieneFecha: false,
    }), true);
  });

  test('pasada la ventana ya no: podría ser un cambio de verdad', () => {
    assert.equal(isDuplicatePmsEvent({
      key: clave, lastKey: clave, lastEpoch: 1_000_000,
      now: 1_000_000 + VENTANA_DUPLICADO_MS + 1, tieneFecha: false,
    }), false);
  });

  test('con fecha utilizable no se mira la clave: ordenar es mejor que adivinar', () => {
    assert.equal(isDuplicatePmsEvent({
      key: clave, lastKey: clave, lastEpoch: 1_000_000, now: 1_000_000 + 60_000,
      tieneFecha: true,
    }), false);
  });

  test('otro aviso distinto no es un reintento', () => {
    const otro = pmsEventKey({ roomKey: '0301', status: 'DISPONIBLE_LIMPIO', changedBy: 'ama01' });
    assert.equal(isDuplicatePmsEvent({
      key: otro, lastKey: clave, lastEpoch: 1_000_000, now: 1_000_000 + 60_000,
      tieneFecha: false,
    }), false);
  });

  test('sin nada recordado, nada es reintento', () => {
    for (const vacio of [null, undefined, '']) {
      assert.equal(isDuplicatePmsEvent({
        key: clave, lastKey: vacio, lastEpoch: 1_000_000, now: 1_000_001, tieneFecha: false,
      }), false);
    }
    assert.equal(isDuplicatePmsEvent({
      key: clave, lastKey: clave, lastEpoch: null, now: 1_000_001, tieneFecha: false,
    }), false);
  });

  test('la clave distingue por habitación, estado, fecha y autor', () => {
    const base = { roomKey: '0301', status: 'SALIDA', changedAt: '2026-11-13T09:00:00', changedBy: 'ama01' };
    const igual = pmsEventKey({ ...base });
    assert.equal(pmsEventKey(base), igual);
    for (const campo of ['roomKey', 'status', 'changedAt', 'changedBy']) {
      assert.notEqual(pmsEventKey({ ...base, [campo]: 'otro' }), igual, `${campo} debería contar`);
    }
  });
});
