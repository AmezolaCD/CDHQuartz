// ============================================================================
// Entrada única desde Core Quartz — fase 05.
//
// El CDH recibe un código de un solo uso, lo canjea contra el shell por la red
// interna con un secreto compartido, y sólo entonces crea **su propia** sesión
// con `createSession()`. Aquí se levanta un shell simulado en un puerto local
// para probar cada respuesta de R4 sin depender del shell de verdad.
//
// Dos invariantes que se vigilan en todo el archivo:
//   · El shell nunca escribe en la base del CDH: `movements` no cambia.
//   · Sin `CQ_URL_INTERNA` o `CQ_SSO_SECRETO`, las tres rutas no existen.
//
//   npm test
// ============================================================================
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const CLAVE = 'Prueba#Sso2026';
const SECRETO = 'secreto-compartido-de-prueba';
const PREFIJO = '/cdh';
const RAIZ = path.resolve(import.meta.dirname, '..');

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function esperarSalud(url, intentos = 60) {
  for (let i = 0; i < intentos; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* todavía arrancando */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`El servidor no respondió en ${url}`);
}

/**
 * Shell simulado: responde el canje con lo que le indique `siguiente`.
 * Guarda lo que recibió para poder afirmar que se mandó el secreto.
 */
async function levantarShell() {
  const estado = {
    /** Próxima respuesta: `{ estado, cuerpo }`. */
    siguiente: { estado: 200, cuerpo: { usuario_modulo: 'amadellaves', nombre: 'Jefa de Ama de Llaves' } },
    llamadas: [],
    /** Con `true`, el shell tarda más de lo que el CDH está dispuesto a esperar. */
    lento: false,
  };
  const servidor = http.createServer(async (peticion, respuesta) => {
    const trozos = [];
    for await (const t of peticion) trozos.push(t);
    let cuerpo = {};
    try { cuerpo = JSON.parse(Buffer.concat(trozos).toString('utf8') || '{}'); } catch { /* vacío */ }
    estado.llamadas.push({
      ruta: peticion.url,
      secreto: peticion.headers['x-cq-secreto'],
      cuerpo,
    });
    if (estado.lento) return; // nunca responde: el CDH debe rendirse solo
    respuesta.writeHead(estado.siguiente.estado, { 'content-type': 'application/json' });
    respuesta.end(JSON.stringify(estado.siguiente.cuerpo));
  });
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  return {
    url: `http://127.0.0.1:${servidor.address().port}`,
    estado,
    cerrar: () => new Promise((listo) => { servidor.closeAllConnections(); servidor.close(() => listo()); }),
  };
}

/** Levanta un CDH con (o sin) las variables de la entrada única. */
async function arrancarCdh({ interna, secreto } = {}) {
  const puerto = await puertoLibre();
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'cdh-sso-'));
  const proceso = spawn(process.execPath, ['server/index.js'], {
    cwd: RAIZ,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(puerto),
      CDH_DATA_DIR: datos,
      CDH_SEED_PASSWORD: CLAVE,
      CDH_BASE_PATH: PREFIJO,
      ...(interna ? { CQ_URL_INTERNA: interna } : {}),
      ...(secreto ? { CQ_SSO_SECRETO: secreto } : {}),
    },
  });
  const base = `http://127.0.0.1:${puerto}${PREFIJO}`;
  await esperarSalud(`${base}/api/health`);

  const abrirBd = () => new Database(path.join(datos, 'cdh.sqlite'), { readonly: true });
  return {
    base,
    url: (ruta) => `${base}${ruta}`,
    movimientos() {
      const bd = abrirBd();
      try { return bd.prepare('SELECT COUNT(*) AS n FROM movements').get().n; } finally { bd.close(); }
    },
    sesionesVivas(username) {
      const bd = abrirBd();
      try {
        return bd.prepare(
          `SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE lower(u.username) = lower(@u) AND s.revoked_at IS NULL`,
        ).get({ u: username }).n;
      } finally { bd.close(); }
    },
    auditoria(accion) {
      const bd = abrirBd();
      try {
        return bd.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = @a').get({ a: accion }).n;
      } finally { bd.close(); }
    },
    desactivar(username) {
      const bd = new Database(path.join(datos, 'cdh.sqlite'));
      try { bd.prepare('UPDATE users SET active = 0 WHERE lower(username) = lower(@u)').run({ u: username }); }
      finally { bd.close(); }
    },
    exigirCambio(username) {
      const bd = new Database(path.join(datos, 'cdh.sqlite'));
      try { bd.prepare('UPDATE users SET must_change_password = 1 WHERE lower(username) = lower(@u)').run({ u: username }); }
      finally { bd.close(); }
    },
    parar() {
      proceso.kill();
      fs.rmSync(datos, { recursive: true, force: true });
    },
  };
}

const canjear = (cdh, codigo) => fetch(cdh.url(`/api/auth/sso?codigo=${encodeURIComponent(codigo)}`), { redirect: 'manual' });

describe('Canje válido', () => {
  let shell; let cdh;
  before(async () => {
    shell = await levantarShell();
    cdh = await arrancarCdh({ interna: shell.url, secreto: SECRETO });
  });
  after(async () => { cdh?.parar(); await shell?.cerrar(); });

  test('crea la sesión del CDH y redirige al prefijo', async () => {
    const r = await canjear(cdh, 'codigo-bueno');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `${PREFIJO}/`);

    const cookie = r.headers.getSetCookie().join('; ');
    assert.match(cookie, /cdh_session=/);
    assert.match(cookie, new RegExp(`Path=${PREFIJO}`));
  });

  test('el código no viaja en la redirección', async () => {
    const r = await canjear(cdh, 'codigo-secreto-visible');
    assert.ok(!(r.headers.get('location') ?? '').includes('codigo-secreto-visible'));
  });

  test('la sesión sirve de verdad: /api/auth/me responde con el usuario', async () => {
    const r = await canjear(cdh, 'otro-codigo');
    const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const yo = await fetch(cdh.url('/api/auth/me'), { headers: { cookie } });
    assert.equal(yo.status, 200);
    assert.equal((await yo.json()).user.username, 'amadellaves');
  });

  test('el canje va al shell con el secreto compartido', () => {
    const ultima = shell.estado.llamadas.at(-1);
    assert.equal(ultima.secreto, SECRETO);
    assert.match(ultima.ruta, /\/portal\/api\/sso\/canjear$/);
  });

  test('queda auditado como sso_login', () => {
    assert.ok(cdh.auditoria('sso_login') >= 1);
  });

  test('un usuario obligado a cambiar contraseña sí entra (lo exige la interfaz)', async () => {
    cdh.exigirCambio('amadellaves');
    const r = await canjear(cdh, 'codigo-con-cambio');
    assert.equal(r.status, 302);
    const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const yo = await fetch(cdh.url('/api/auth/me'), { headers: { cookie } });
    assert.equal((await yo.json()).user.mustChangePassword, true);
  });
});

describe('Canjes que el shell rechaza', () => {
  let shell; let cdh;
  before(async () => {
    shell = await levantarShell();
    cdh = await arrancarCdh({ interna: shell.url, secreto: SECRETO });
  });
  after(async () => { cdh?.parar(); await shell?.cerrar(); });

  for (const [estado, motivo] of [[410, 'usado'], [410, 'vencido'], [403, 'inactivo'], [409, 'modulo']]) {
    test(`${estado} ${motivo}: página de error, sin sesión`, async () => {
      shell.estado.siguiente = { estado, cuerpo: { motivo } };
      const r = await canjear(cdh, `codigo-${motivo}`);
      assert.ok(r.status >= 400, `debería ser una página de error, no ${r.status}`);
      assert.equal(r.headers.getSetCookie().length, 0, 'no debe poner cookie');
      assert.match(r.headers.get('content-type') ?? '', /text\/html/);
      const html = await r.text();
      assert.match(html, /<html/i);
    });
  }

  test('los rechazos quedan auditados como sso_rechazo', () => {
    assert.ok(cdh.auditoria('sso_rechazo') >= 4);
  });

  test('un usuario que no existe en el CDH no obtiene sesión', async () => {
    shell.estado.siguiente = { estado: 200, cuerpo: { usuario_modulo: 'fantasma', nombre: 'Fantasma' } };
    const r = await canjear(cdh, 'codigo-fantasma');
    assert.ok(r.status >= 400);
    assert.equal(r.headers.getSetCookie().length, 0);
  });

  test('un usuario desactivado en el CDH tampoco', async () => {
    cdh.desactivar('recepcion');
    shell.estado.siguiente = { estado: 200, cuerpo: { usuario_modulo: 'recepcion', nombre: 'Recepción' } };
    const r = await canjear(cdh, 'codigo-inactivo-cdh');
    assert.ok(r.status >= 400);
    assert.equal(r.headers.getSetCookie().length, 0);
  });
});

describe('El shell no responde', () => {
  let shell; let cdh;
  before(async () => {
    shell = await levantarShell();
    cdh = await arrancarCdh({ interna: shell.url, secreto: SECRETO });
  });
  after(async () => { cdh?.parar(); await shell?.cerrar(); });

  test('se rinde en menos de 5 s con una página en español y sin sesión', async () => {
    shell.estado.lento = true;
    const inicio = Date.now();
    const r = await canjear(cdh, 'codigo-sin-respuesta');
    const tardo = Date.now() - inicio;
    assert.ok(tardo < 5_000, `tardó ${tardo} ms en rendirse`);
    assert.ok(r.status >= 400);
    assert.equal(r.headers.getSetCookie().length, 0);
    assert.match(await r.text(), /No se pudo verificar la entrada/i);
  });
});

describe('Rutas internas para el shell', () => {
  let shell; let cdh;
  before(async () => {
    shell = await levantarShell();
    cdh = await arrancarCdh({ interna: shell.url, secreto: SECRETO });
  });
  after(async () => { cdh?.parar(); await shell?.cerrar(); });

  test('consultar un usuario con el secreto devuelve existe y activo', async () => {
    const r = await fetch(cdh.url('/api/auth/sso/usuario/amadellaves'), {
      headers: { 'x-cq-secreto': SECRETO },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { existe: true, activo: true });
  });

  test('un usuario que no existe se reporta como tal, no como error', async () => {
    const r = await fetch(cdh.url('/api/auth/sso/usuario/fantasma'), {
      headers: { 'x-cq-secreto': SECRETO },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { existe: false, activo: false });
  });

  test('sin secreto la ruta no existe', async () => {
    assert.equal((await fetch(cdh.url('/api/auth/sso/usuario/amadellaves'))).status, 404);
  });

  test('revocar deja al usuario sin sesiones vivas', async () => {
    const entrada = await canjear(cdh, 'codigo-para-revocar');
    assert.equal(entrada.status, 302);
    assert.ok(cdh.sesionesVivas('amadellaves') >= 1);

    const r = await fetch(cdh.url('/api/auth/sso/revocar'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cq-secreto': SECRETO },
      body: JSON.stringify({ usuario_modulo: 'amadellaves' }),
    });
    assert.equal(r.status, 200);
    assert.equal(cdh.sesionesVivas('amadellaves'), 0);
  });

  test('revocar sin secreto: 404 y no cambia nada', async () => {
    await canjear(cdh, 'codigo-otra-sesion');
    const antes = cdh.sesionesVivas('amadellaves');
    const r = await fetch(cdh.url('/api/auth/sso/revocar'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usuario_modulo: 'amadellaves' }),
    });
    assert.equal(r.status, 404);
    assert.equal(cdh.sesionesVivas('amadellaves'), antes);
  });
});

describe('Sin las variables configuradas, la entrada única no existe', () => {
  let cdh;
  before(async () => { cdh = await arrancarCdh({}); });
  after(() => cdh?.parar());

  test('las tres rutas responden 404', async () => {
    assert.equal((await fetch(cdh.url('/api/auth/sso?codigo=x'))).status, 404);
    assert.equal((await fetch(cdh.url('/api/auth/sso/usuario/admin'))).status, 404);
    assert.equal((await fetch(cdh.url('/api/auth/sso/revocar'), { method: 'POST' })).status, 404);
  });

  test('el login de siempre sigue funcionando', async () => {
    const r = await fetch(cdh.url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: CLAVE }),
    });
    assert.equal(r.status, 200);
  });
});

describe('Invariante 1 · el shell no escribe en la base del CDH', () => {
  let shell; let cdh;
  before(async () => {
    shell = await levantarShell();
    cdh = await arrancarCdh({ interna: shell.url, secreto: SECRETO });
  });
  after(async () => { cdh?.parar(); await shell?.cerrar(); });

  test('ni un solo movimiento tras entrar, rechazar y revocar', async () => {
    const antes = cdh.movimientos();

    await canjear(cdh, 'codigo-1');
    shell.estado.siguiente = { estado: 410, cuerpo: { motivo: 'usado' } };
    await canjear(cdh, 'codigo-2');
    await fetch(cdh.url('/api/auth/sso/revocar'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cq-secreto': SECRETO },
      body: JSON.stringify({ usuario_modulo: 'amadellaves' }),
    });

    assert.equal(cdh.movimientos(), antes, 'el historial del CDH es intocable');
  });
});
