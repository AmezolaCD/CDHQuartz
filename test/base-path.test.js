// ============================================================================
// Prefijo de ruta (`CDH_BASE_PATH`) — fase 05 de Core Quartz.
//
// El CDH pasa a servirse en `core-quartz.vercel.app/cdh/`, así que toda la
// aplicación tiene que poder montarse bajo un prefijo. La regla que protege al
// CDH de hoy es sencilla: **sin la variable, todo se comporta exactamente
// igual que antes**, y eso también se prueba aquí.
//
// El servidor se levanta como proceso aparte, igual que en las pruebas de
// interfaz: así se prueba el arranque de verdad y no una versión importada.
//
//   npm test
// ============================================================================
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const CLAVE = 'Prueba#BasePath2026';
const RAIZ = path.resolve(import.meta.dirname, '..');

/** Puerto libre, para no chocar con un servidor de desarrollo ya abierto. */
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
 * Levanta un CDH con su propia carpeta de datos y devuelve cómo hablarle.
 * `prefijo` es el valor de `CDH_BASE_PATH` (vacío = como hoy).
 */
async function arrancar(prefijo = '') {
  const puerto = await puertoLibre();
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'cdh-prefijo-'));
  const proceso = spawn(process.execPath, ['server/index.js'], {
    cwd: RAIZ,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(puerto),
      CDH_DATA_DIR: datos,
      CDH_SEED_PASSWORD: CLAVE,
      ...(prefijo ? { CDH_BASE_PATH: prefijo } : {}),
    },
  });
  const base = `http://127.0.0.1:${puerto}`;
  await esperarSalud(`${base}${prefijo}/api/health`);
  return {
    base,
    prefijo,
    datos,
    url: (ruta) => `${base}${prefijo}${ruta}`,
    /** Filas de `movements`, leídas directo del archivo (sólo lectura). */
    movimientos() {
      const bd = new Database(path.join(datos, 'cdh.sqlite'), { readonly: true });
      try {
        return bd.prepare('SELECT COUNT(*) AS n FROM movements').get().n;
      } finally {
        bd.close();
      }
    },
    parar() {
      proceso.kill();
      fs.rmSync(datos, { recursive: true, force: true });
    },
  };
}

/** Entra como `admin` y devuelve la cabecera `Set-Cookie` cruda. */
async function cookieDeEntrada(servidor) {
  const r = await fetch(servidor.url('/api/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: CLAVE }),
  });
  assert.equal(r.status, 200, 'la entrada debería funcionar igual con o sin prefijo');
  return r.headers.getSetCookie().join('; ');
}

describe('Sin CDH_BASE_PATH el CDH es el de hoy', () => {
  let cdh;
  before(async () => { cdh = await arrancar(''); });
  after(() => cdh?.parar());

  test('/api/health responde en la raíz', async () => {
    const r = await fetch(`${cdh.base}/api/health`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).app, 'CDH');
  });

  test('la interfaz se sirve en /', async () => {
    const r = await fetch(`${cdh.base}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<div id="app">/);
  });

  test('los estáticos siguen en /css y /js', async () => {
    assert.equal((await fetch(`${cdh.base}/css/app.css`)).status, 200);
    assert.equal((await fetch(`${cdh.base}/js/app.js`)).status, 200);
  });

  test('la cookie de sesión conserva Path=/', async () => {
    const cookie = await cookieDeEntrada(cdh);
    assert.match(cookie, /cdh_session=/);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Path=\/cdh/);
  });

  test('una ruta de API inexistente sigue dando 404 con su JSON', async () => {
    const r = await fetch(`${cdh.base}/api/no-existe`);
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /Ruta de API no encontrada/);
  });
});

describe('Con CDH_BASE_PATH=/cdh todo vive bajo el prefijo', () => {
  let cdh;
  before(async () => { cdh = await arrancar('/cdh'); });
  after(() => cdh?.parar());

  test('/cdh/api/health responde y /api/health ya no existe', async () => {
    const conPrefijo = await fetch(`${cdh.base}/cdh/api/health`);
    assert.equal(conPrefijo.status, 200);
    assert.equal((await conPrefijo.json()).app, 'CDH');

    const sinPrefijo = await fetch(`${cdh.base}/api/health`);
    assert.equal(sinPrefijo.status, 404, 'fuera del prefijo no debe haber nada');
  });

  test('GET /cdh redirige con 301 a /cdh/', async () => {
    const r = await fetch(`${cdh.base}/cdh`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/cdh/');
    // El cuerpo se consume siempre: una respuesta a medio leer deja el socket
    // sin poder reutilizarse y la siguiente petición falla por red.
    await r.text();
  });

  test('la interfaz se sirve en /cdh/ y trae <base href="/cdh/">', async () => {
    const r = await fetch(`${cdh.base}/cdh/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<base href="\/cdh\/">/);
    assert.match(html, /<div id="app">/);
  });

  test('los estáticos viven bajo el prefijo y no fuera', async () => {
    assert.equal((await fetch(`${cdh.base}/cdh/css/app.css`)).status, 200);
    assert.equal((await fetch(`${cdh.base}/cdh/js/app.js`)).status, 200);
    assert.equal((await fetch(`${cdh.base}/css/app.css`)).status, 404);
    assert.equal((await fetch(`${cdh.base}/js/app.js`)).status, 404);
  });

  test('el enrutador de la SPA sigue devolviendo la página bajo el prefijo', async () => {
    const r = await fetch(`${cdh.base}/cdh/lo-que-sea`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<div id="app">/);
  });

  test('la cookie de sesión lleva Path=/cdh', async () => {
    const cookie = await cookieDeEntrada(cdh);
    assert.match(cookie, /cdh_session=/);
    assert.match(cookie, /Path=\/cdh/);
  });

  test('con la cookie del prefijo se puede consultar /cdh/api/auth/me', async () => {
    const cookie = await cookieDeEntrada(cdh);
    const r = await fetch(`${cdh.base}/cdh/api/auth/me`, { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).user.username, 'admin');
  });

  test('montar el prefijo no escribe un solo movimiento', async () => {
    assert.equal(cdh.movimientos(), 0, 'el historial no se toca al montar la aplicación');
  });
});

describe('La interfaz no lleva rutas absolutas', () => {
  test('no queda ninguna ruta /api, /css, /js ni /assets en public', () => {
    // Mismo criterio que pide la fase. `grep` devuelve 1 cuando no encuentra
    // nada, que es justo el resultado bueno.
    let salida = '';
    try {
      salida = execFileSync('grep', ['-rnE', `['"\`]/(api|css|js|assets)/`, 'public'], {
        cwd: RAIZ, encoding: 'utf8',
      });
    } catch (error) {
      if (error.status === 1) return; // sin resultados: correcto
      throw error;
    }
    assert.fail(`quedan rutas absolutas en public:\n${salida}`);
  });
});
