// Pruebas de la lógica pura de la entrada del PMS. No tocan base de datos:
// la regla de precedencia es lo que no se puede equivocar y se prueba sola.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  roomNumberFromKey, decidePrecedence, epochFromPmsTimestamp, isStalePmsEvent,
  pmsComment, pmsEventInstant, ESTADOS_PROPIOS_DEL_CDH, PMS_MOVEMENT_TYPE,
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

  test('rechaza lo que no sea exactamente cuatro dígitos', () => {
    for (const malo of ['415', '00301', '', '  ', 'abcd', '03o1', '0301 ', '10022']) {
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
        const d = decidePrecedence({ currentStatusCode: actual, incomingStatusCode: entra });
        assert.equal(d.apply, false, `${actual} no debió ceder ante ${entra}`);
        assert.equal(d.reason, 'estado_propio_del_cdh');
      }
    }
  });

  test('el caso que decide todo: fuera de servicio no vuelve a la venta', () => {
    const d = decidePrecedence({
      currentStatusCode: 'FUERA_SERVICIO', incomingStatusCode: 'DISPONIBLE_LIMPIO',
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

  test('la regla se agota: cerrado el pendiente, Arpón recupera el mando', () => {
    // Misma habitación, antes y después de "Liberar habitación" en el CDH.
    assert.equal(decidePrecedence({
      currentStatusCode: 'FUERA_SERVICIO', incomingStatusCode: 'OCUPADO_LIMPIO',
    }).apply, false);
    assert.equal(decidePrecedence({
      currentStatusCode: 'DISPONIBLE_LIMPIO', incomingStatusCode: 'OCUPADO_LIMPIO',
    }).apply, true);
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

describe('El instante que se guarda', () => {
  const tz = 'America/Tijuana';

  test('normaliza a UTC, venga con zona o sin ella', () => {
    assert.equal(pmsEventInstant('2026-11-13T09:14:00', tz), '2026-11-13T17:14:00.000Z');
    assert.equal(pmsEventInstant('2026-11-13T17:14:00Z', tz), '2026-11-13T17:14:00.000Z');
    assert.equal(pmsEventInstant('2026-11-13T09:14:00-08:00', tz), '2026-11-13T17:14:00.000Z');
  });

  test('lo que vuelve se puede volver a leer sin perder nada', () => {
    const guardado = pmsEventInstant('2026-11-13T09:14:00', tz);
    assert.equal(epochFromPmsTimestamp(guardado, tz), epochFromPmsTimestamp('2026-11-13T09:14:00', tz));
  });

  test('una fecha que no se entiende no se guarda', () => {
    for (const malo of [null, '', 'ayer', 42]) assert.equal(pmsEventInstant(malo, tz), null);
  });
});

describe('Entregas desordenadas', () => {
  const tz = 'America/Tijuana';
  // Como lo guarda la ruta: el instante del último aviso del PMS, en UTC.
  const anterior = pmsEventInstant('2026-11-13T09:00:00', tz);

  test('un aviso anterior al último del PMS se descarta', () => {
    assert.equal(isStalePmsEvent({ changedAt: '2026-11-13T08:00:00', lastEventAt: anterior, tz }), true);
  });

  test('un aviso posterior se procesa', () => {
    assert.equal(isStalePmsEvent({ changedAt: '2026-11-13T09:14:00', lastEventAt: anterior, tz }), false);
  });

  test('el mismo instante no es desorden: es un reintento', () => {
    assert.equal(isStalePmsEvent({ changedAt: '2026-11-13T09:00:00', lastEventAt: anterior, tz }), false);
  });

  test('sin un aviso previo no hay nada que comparar, así que se procesa', () => {
    // Éste es el caso del primer día: antes se comparaba contra
    // `rooms.status_changed_at`, que en una base recién sembrada vale la hora
    // de arranque de las 155 y no un cambio real. Un aviso legítimo con hora
    // un poco anterior se perdía en silencio.
    assert.equal(isStalePmsEvent({ changedAt: '2020-01-01T08:00:00', lastEventAt: null, tz }), false);
    assert.equal(isStalePmsEvent({ changedAt: '2020-01-01T08:00:00', lastEventAt: '', tz }), false);
  });

  test('un cambio hecho en el CDH no vuelve viejo a un aviso de Arpón', () => {
    // No es cuestión de orden sino de autoridad, y la decide la precedencia.
    // La función ni mira el reloj del CDH: compara dos marcas de Arpón, que es
    // lo único comparable entre sí.
    assert.equal(isStalePmsEvent({
      changedAt: '2026-11-13T08:00:00',
      lastEventAt: null,
      statusChangedAt: '2026-11-13T23:00:00.000Z',   // se ignora a propósito
      tz,
    }), false);
  });

  test('la conversión de zona sigue importando entre dos marcas de Arpón', () => {
    // El aviso llega sin zona y el guardado está en UTC: leído como UTC,
    // "09:14" parecería anterior a las 17:00Z y se perdería.
    const guardado = '2026-11-13T17:00:00.000Z';      // 09:00 local
    assert.ok(Date.parse('2026-11-13T09:14:00Z') < Date.parse(guardado), 'premisa de la trampa');
    assert.equal(isStalePmsEvent({ changedAt: '2026-11-13T09:14:00', lastEventAt: guardado, tz }), false);
  });

  test('ante la duda no se descarta', () => {
    assert.equal(isStalePmsEvent({ changedAt: null, lastEventAt: anterior, tz }), false);
    assert.equal(isStalePmsEvent({ changedAt: 'ayer', lastEventAt: anterior, tz }), false);
    assert.equal(isStalePmsEvent({ changedAt: '2026-11-13T08:00:00', lastEventAt: 'ayer', tz }), false);
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
