// La ruta de entrada del PMS, de punta a punta: autenticación, interruptor,
// códigos pensados para un webhook con reintentos y el movimiento que queda.
// La REGLA de precedencia se prueba aparte y en puro (test/pms.test.js); aquí
// se comprueba que esté bien cableada.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

const RAIZ = path.resolve(import.meta.dirname, '..');
const CLAVE = 'Quartz#Prueba1';
const TOKEN = 'token-del-pms-de-prueba';

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function esperarSalud(url, intentos = 60) {
  for (let i = 0; i < intentos; i += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* arrancando */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`El servidor no respondió en ${url}`);
}

async function arrancarCdh({ token = TOKEN } = {}) {
  const puerto = await puertoLibre();
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'cdh-pms-'));
  const proceso = spawn(process.execPath, ['server/index.js'], {
    cwd: RAIZ,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(puerto),
      CDH_DATA_DIR: datos,
      CDH_SEED_PASSWORD: CLAVE,
      ...(token ? { CDH_PMS_TOKEN: token } : {}),
    },
  });
  const base = `http://127.0.0.1:${puerto}`;
  await esperarSalud(`${base}/api/health`);
  const bdPath = path.join(datos, 'cdh.sqlite');

  const api = {
    url: (ruta) => `${base}${ruta}`,

    /** Manda un evento del PMS. */
    evento: (cuerpo, { autorizacion = `Bearer ${token}` } = {}) => fetch(`${base}/api/integrations/pms/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(autorizacion ? { authorization: autorizacion } : {}),
      },
      body: JSON.stringify(cuerpo),
    }),

    /** Sesión de administrador, para encender el interruptor como se haría. */
    async cookieAdmin() {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: CLAVE }),
      });
      assert.equal(r.status, 200, 'el login de admin debería funcionar');
      return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    },

    async encenderEntrada() {
      const cookie = await api.cookieAdmin();
      const r = await fetch(`${base}/api/admin/settings/pms_inbound_enabled`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ value: '1' }),
      });
      assert.equal(r.status, 200);
      return cookie;
    },

    consulta(sql, params = {}) {
      const bd = new Database(bdPath, { readonly: true });
      try { return bd.prepare(sql).all(params); } finally { bd.close(); }
    },

    estado(numero) {
      return api.consulta(
        `SELECT s.code AS code, r.status_changed_at AS cambiado
           FROM rooms r JOIN room_statuses s ON s.id = r.status_id
          WHERE r.number = @n`, { n: String(numero) })[0];
    },

    movimientos(numero) {
      return api.consulta(
        `SELECT action_code, user_name, comment, field_label,
                old_value, new_value, old_status_name, new_status_name
           FROM movements WHERE room_number = @n ORDER BY id`, { n: String(numero) });
    },

    conflicto(numero) {
      return api.consulta(
        'SELECT pms_conflict_status AS estado, pms_conflict_at AS desde FROM rooms WHERE number = @n',
        { n: String(numero) })[0];
    },

    async atencion(cookie) {
      const r = await fetch(`${base}/api/dashboard/attention?limit=300`, { headers: { cookie } });
      assert.equal(r.status, 200);
      return (await r.json()).items;
    },

    auditoria(accion) {
      return api.consulta('SELECT COUNT(*) AS n FROM audit_log WHERE action = @a', { a: accion })[0].n;
    },

    /** Pone un estado directo en la base: aquí se prueba el cableado, no la regla. */
    /**
     * Abre o cierra el pendiente que sostiene a "Fuera de servicio" y a
     * "Discrepancia": un campo de Mantenimiento en falla. Sin esto, forzar el
     * estado a secas monta una habitación que ningún pendiente respalda, y la
     * regla de precedencia —con razón— le devuelve el mando al PMS.
     */
    pendiente(numero, abierto) {
      const bd = new Database(bdPath);
      try {
        bd.prepare(`UPDATE room_details SET value = @v
                     WHERE room_id = (SELECT id FROM rooms WHERE number = @n)
                       AND field_id = (SELECT id FROM fields WHERE code = 'plomeria')`)
          .run({ v: abierto ? 'Falla' : 'OK', n: String(numero) });
      } finally { bd.close(); }
    },

    forzarEstado(numero, code) {
      const bd = new Database(bdPath);
      try {
        bd.prepare(`UPDATE rooms SET status_id = (SELECT id FROM room_statuses WHERE code = @c)
                     WHERE number = @n`).run({ c: code, n: String(numero) });
      } finally { bd.close(); }
    },

    async parar() {
      if (proceso.exitCode !== null) return;
      proceso.kill('SIGTERM');
      await new Promise((r) => proceso.once('exit', r));
    },
  };
  return api;
}

describe('Entrada del PMS: autenticación e interruptor', () => {
  let cdh;
  before(async () => { cdh = await arrancarCdh(); });
  after(async () => { await cdh?.parar(); });

  test('con el token correcto pero apagada, responde 503', async () => {
    const r = await cdh.evento({ roomKey: '0415', status: 'OCUPADO_SUCIO' });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /apagada/i);
  });

  test('sin cabecera de autorización, 401', async () => {
    const r = await cdh.evento({ roomKey: '0415', status: 'OCUPADO_SUCIO' }, { autorizacion: null });
    assert.equal(r.status, 401);
  });

  test('con el token equivocado, 401', async () => {
    const r = await cdh.evento({ roomKey: '0415', status: 'OCUPADO_SUCIO' }, { autorizacion: 'Bearer otro' });
    assert.equal(r.status, 401);
  });

  test('el token se comprueba ANTES del interruptor: quien no lo trae no sabe si existe', async () => {
    // Las dos respuestas de arriba son 401 con la entrada apagada: el 503 sólo
    // lo ve quien ya se autenticó.
    const sinToken = await cdh.evento({ roomKey: '0415', status: 'OCUPADO_SUCIO' }, { autorizacion: null });
    const conToken = await cdh.evento({ roomKey: '0415', status: 'OCUPADO_SUCIO' });
    assert.equal(sinToken.status, 401);
    assert.equal(conToken.status, 503);
  });

  test('apagada no escribe nada', async () => {
    assert.equal(cdh.movimientos('415').length, 0);
    assert.equal(cdh.estado('415').code, 'DISPONIBLE_LIMPIO');
  });
});

describe('Sin CDH_PMS_TOKEN en el entorno', () => {
  let cdh;
  before(async () => { cdh = await arrancarCdh({ token: null }); });
  after(async () => { await cdh?.parar(); });

  test('responde 503 y lo dice: es un despliegue a medio configurar', async () => {
    const r = await cdh.evento({ roomKey: '0415', status: 'OCUPADO_SUCIO' }, { autorizacion: 'Bearer lo-que-sea' });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /CDH_PMS_TOKEN/);
  });
});

describe('Entrada del PMS encendida', () => {
  let cdh; let cookie;
  before(async () => { cdh = await arrancarCdh(); cookie = await cdh.encenderEntrada(); });
  after(async () => { await cdh?.parar(); });

  test('el descubrimiento ya reporta el PMS habilitado', async () => {
    const r = await fetch(cdh.url('/api/integrations/'), { headers: { cookie } });
    const { integrations } = await r.json();
    assert.equal(integrations.find((i) => i.code === 'pms').enabled, true);
    assert.equal(integrations.find((i) => i.code === 'wifi').enabled, false);
  });

  test('un evento válido mueve la habitación y la firma Arpón', async () => {
    const r = await cdh.evento({
      roomKey: '0415', status: 'OCUPADO_SUCIO',
      changedAt: new Date(Date.now() + 60_000).toISOString(), changedBy: 'ama01',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(
      { ...(await r.json()), movementId: undefined },
      { ok: true, applied: true, reason: 'aplicado', room: '415', movementId: undefined },
    );
    assert.equal(cdh.estado('415').code, 'OCUPADO_SUCIO');

    const movs = cdh.movimientos('415');
    assert.equal(movs.length, 1);
    assert.equal(movs[0].action_code, 'PMS_EVENT');
    assert.equal(movs[0].user_name, 'Arpón Enterprise');
    assert.match(movs[0].comment, /ama01/);
  });

  test('el mismo evento otra vez no genera movimiento', async () => {
    const antes = cdh.movimientos('415').length;
    const r = await cdh.evento({ roomKey: '0415', status: 'OCUPADO_SUCIO' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).reason, 'sin_cambio');
    assert.equal(cdh.movimientos('415').length, antes, 'un reintento no debe ensuciar el historial');
  });

  test('"0301" se resuelve a la habitación 301', async () => {
    const r = await cdh.evento({ roomKey: '0301', status: 'SALIDA' });
    assert.equal((await r.json()).room, '301');
    assert.equal(cdh.estado('301').code, 'SALIDA');
  });

  test('un roomKey de tres dígitos también resuelve: el formato de producción no está confirmado', async () => {
    // La documentación de Arpón trae claves de tres ("101", "201") y el hotel
    // de pruebas las da de cuatro. Si exigiéramos cuatro y producción mandara
    // tres, se rechazaría el cien por cien de los eventos.
    const r = await cdh.evento({ roomKey: '415', status: 'OCUPADO_LIMPIO' });
    assert.equal(r.status, 200);
    const cuerpo = await r.json();
    assert.equal(cuerpo.room, '415');
    assert.equal(cuerpo.applied, true);
  });

  test('lo que no es un número de habitación sigue siendo 400', async () => {
    for (const malo of ['41', '00415', 'abcd', '']) {
      const r = await cdh.evento({ roomKey: malo, status: 'OCUPADO_LIMPIO' });
      assert.equal(r.status, 400, `debió rechazar ${JSON.stringify(malo)}`);
      assert.equal((await r.json()).reason, 'formato_de_roomkey');
    }
  });

  test('sin estado, 400', async () => {
    const r = await cdh.evento({ roomKey: '0415' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).reason, 'sin_estado');
  });

  test('un estado que no existe lo rechaza la puerta de escritura, con 400', async () => {
    const r = await cdh.evento({ roomKey: '0415', status: 'NO_EXISTE' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).reason, 'rechazado_al_registrar');
  });

  test('una habitación que el CDH no tiene: 200 y a la bitácora, no 404', async () => {
    // Un 404 haría a Arpón reintentar para siempre una condición permanente.
    const r = await cdh.evento({ roomKey: '0999', status: 'SALIDA' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, applied: false, reason: 'habitacion_desconocida' });
    assert.ok(cdh.auditoria('pms_evento_ignorado') >= 1);
  });

  test('un evento rezagado se descarta sin tocar el estado', async () => {
    const antes = cdh.estado('301');
    const r = await cdh.evento({
      roomKey: '0301', status: 'OCUPADO_LIMPIO',
      changedAt: '2020-01-01T08:00:00',
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).reason, 'evento_rezagado');
    assert.equal(cdh.estado('301').code, antes.code);
    assert.ok(cdh.auditoria('pms_evento_rezagado') >= 1);
  });

  test('fuera de servicio no vuelve a la venta, y el aviso queda en el historial', async () => {
    cdh.forzarEstado('0502'.replace(/^0+/, ''), 'FUERA_SERVICIO');
    cdh.pendiente('502', true);
    const antes = cdh.movimientos('502').length;

    const r = await cdh.evento({
      roomKey: '0502', status: 'DISPONIBLE_LIMPIO', changedBy: 'ama01',
    });
    assert.equal(r.status, 200);
    const cuerpo = await r.json();
    assert.equal(cuerpo.applied, false);
    assert.equal(cuerpo.reason, 'estado_propio_del_cdh');

    assert.equal(cdh.estado('502').code, 'FUERA_SERVICIO', 'no debió cederle a Arpón');

    const movs = cdh.movimientos('502');
    assert.equal(movs.length, antes + 1, 'el evento rechazado también deja constancia');
    assert.equal(movs.at(-1).action_code, 'PMS_EVENT');
    assert.equal(movs.at(-1).new_status_name, movs.at(-1).old_status_name,
      'un movimiento que no mueve nada guarda el estado de ese momento en los dos campos');
    assert.equal(movs.at(-1).new_value, null, 'no hubo cambio de estado que anotar');
    assert.match(movs.at(-1).comment, /Disponible limpio/);
    assert.match(movs.at(-1).comment, /Fuera de servicio/);
  });

  test('cerrado el pendiente, Arpón recupera el mando', async () => {
    cdh.forzarEstado('502', 'DISPONIBLE_LIMPIO');
    const r = await cdh.evento({ roomKey: '0502', status: 'OCUPADO_LIMPIO' });
    assert.equal((await r.json()).applied, true);
    assert.equal(cdh.estado('502').code, 'OCUPADO_LIMPIO');
  });
});

describe('El desacuerdo con el PMS se ve en el rack', () => {
  let cdh; let cookie;
  before(async () => { cdh = await arrancarCdh(); cookie = await cdh.encenderEntrada(); });
  after(async () => { await cdh?.parar(); });

  test('un aviso rechazado queda anotado en la habitación', async () => {
    cdh.forzarEstado('602', 'FUERA_SERVICIO');
    cdh.pendiente('602', true);
    assert.equal(cdh.conflicto('602').estado, null, 'premisa: nace sin desacuerdo');

    const r = await cdh.evento({ roomKey: '0602', status: 'DISPONIBLE_LIMPIO' });
    assert.equal((await r.json()).reason, 'estado_propio_del_cdh');

    const c = cdh.conflicto('602');
    assert.equal(c.estado, 'DISPONIBLE_LIMPIO');
    assert.ok(c.desde, 'debe guardar desde cuándo');
  });

  test('aparece en "Requiere atención", con el nombre que usa el hotel', async () => {
    const items = await cdh.atencion(cookie);
    const fila = items.find((i) => i.number === '602');
    assert.ok(fila, 'la habitación debería estar en la lista');
    const motivo = fila.reasons.find((x) => x.code === 'pms');
    assert.ok(motivo, `no se vio el motivo del PMS: ${JSON.stringify(fila.reasons)}`);
    // El código no se le muestra a nadie: se lee con el nombre del estado.
    assert.match(motivo.label, /Disponible limpio/);
    assert.ok(!motivo.label.includes('DISPONIBLE_LIMPIO'));
  });

  test('si Arpón vuelve a coincidir, el aviso se apaga sin dejar movimiento', async () => {
    const antes = cdh.movimientos('602').length;
    const r = await cdh.evento({ roomKey: '0602', status: 'FUERA_SERVICIO' });
    assert.equal((await r.json()).reason, 'sin_cambio');
    assert.equal(cdh.conflicto('602').estado, null, 'el desacuerdo terminó');
    assert.equal(cdh.movimientos('602').length, antes, 'no pasó nada que registrar');
  });

  test('y ya no sale en la lista por ese motivo', async () => {
    const fila = (await cdh.atencion(cookie)).find((i) => i.number === '602');
    // Sigue en la lista por estar fuera de servicio, pero sin el aviso del PMS.
    assert.ok(!fila.reasons.some((x) => x.code === 'pms'));
  });

  test('cerrado el pendiente, Arpón recupera el mando aunque el estado no cambie', async () => {
    // El caso del piso: una fuga deja la 604 fuera de servicio y Mantenimiento
    // la repara. Cerrar el pendiente NO cambia el estado —en el CDH hay que
    // liberarla—, así que antes de este arreglo la habitación se quedaba
    // sorda a Arpón para siempre.
    cdh.forzarEstado('604', 'FUERA_SERVICIO');
    cdh.pendiente('604', true);
    const conPendiente = await cdh.evento({ roomKey: '0604', status: 'OCUPADO_LIMPIO' });
    assert.equal((await conPendiente.json()).reason, 'estado_propio_del_cdh');
    assert.equal(cdh.estado('604').code, 'FUERA_SERVICIO');

    // Mantenimiento repara: el pendiente se cierra, el estado sigue igual.
    cdh.pendiente('604', false);
    assert.equal(cdh.estado('604').code, 'FUERA_SERVICIO', 'premisa: el estado no se movió solo');

    const yaReparada = await cdh.evento({ roomKey: '0604', status: 'OCUPADO_LIMPIO' });
    const cuerpo = await yaReparada.json();
    assert.equal(cuerpo.applied, true, 'ya no hay nada que sostenga el estado del CDH');
    assert.equal(cuerpo.reason, 'pendiente_cerrado');
    assert.equal(cdh.estado('604').code, 'OCUPADO_LIMPIO');
  });

  test('mover la habitación por cualquier vía también limpia el desacuerdo', async () => {
    cdh.forzarEstado('603', 'FUERA_SERVICIO');
    cdh.pendiente('603', true);
    await cdh.evento({ roomKey: '0603', status: 'DISPONIBLE_LIMPIO' });
    assert.equal(cdh.conflicto('603').estado, 'DISPONIBLE_LIMPIO', 'premisa: hay desacuerdo');

    // Se levanta el fuera de servicio y entra un aviso que SÍ se aplica: la
    // marca la limpia `recordMovement`, no la ruta.
    cdh.forzarEstado('603', 'SALIDA');
    cdh.pendiente('603', false);
    const r = await cdh.evento({ roomKey: '0603', status: 'DISPONIBLE_LIMPIO' });
    assert.equal((await r.json()).applied, true);
    assert.equal(cdh.conflicto('603').estado, null);
  });
});
