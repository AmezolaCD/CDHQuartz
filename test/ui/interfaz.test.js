// ============================================================================
// Pruebas de interfaz en navegador real.
//
// Cubren lo que las pruebas de servidor no pueden ver: el ciclo de vida del
// DOM al navegar. El expediente de habitación se apiló dos veces en producción
// porque los manejadores se acumulaban sobre nodos compartidos, y ninguna
// prueba de lógica podía detectarlo.
//
//   npm run test:ui
// ============================================================================
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const CLAVE = 'Prueba#Interfaz2026';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cdh-ui-'));
const RAIZ = path.resolve(import.meta.dirname, '..', '..');

let servidor; let navegador; let base;

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
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return;
    } catch { /* todavía arrancando */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`El servidor no respondió en ${url}`);
}

before(async () => {
  const puerto = await puertoLibre();
  base = `http://127.0.0.1:${puerto}`;
  servidor = spawn(process.execPath, ['server/index.js'], {
    cwd: RAIZ,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(puerto), CDH_DATA_DIR: TMP, CDH_SEED_PASSWORD: CLAVE },
  });
  await esperarSalud(base);
  navegador = await chromium.launch({
    // En CI se usa el Chromium que instala Playwright; la variable permite
    // apuntar a uno ya presente en la imagen de desarrollo.
    executablePath: process.env.CDH_CHROMIUM_PATH || undefined,
  });
});

after(async () => {
  await navegador?.close();
  servidor?.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Sesión iniciada y aviso de contraseña descartado. */
async function abrirSesion(usuario = 'sistemas') {
  const page = await navegador.newPage({ viewport: { width: 1440, height: 940 } });
  const errores = [];
  page.on('pageerror', (e) => errores.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errores.push(m.text()); });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.fill('#u', usuario);
  await page.fill('#p', CLAVE);
  await page.click('#loginForm [type=submit]');
  await page.waitForSelector('.appbar');
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('.modal-wrap')?.remove());
  return { page, errores };
}

const paneles = (page) => page.evaluate(() => document.querySelectorAll('.drawer').length);

/** Manejadores 'click' REALES sobre un nodo, según el protocolo de DevTools. */
async function manejadores(page, selector) {
  const cdp = await page.context().newCDPSession(page);
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    objectGroup: 'sonda',
  });
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'sonda' });
  await cdp.detach();
  return listeners.filter((l) => l.type === 'click').length;
}

describe('Expediente de habitación', () => {
  test('navegar entre vistas no acumula manejadores en el outlet', async () => {
    const { page } = await abrirSesion();
    const inicial = await manejadores(page, '[data-outlet]');
    for (let i = 0; i < 5; i += 1) {
      await page.evaluate(() => { location.hash = '#/pisos'; });
      await page.waitForSelector('.rack-grid');
      await page.evaluate(() => { location.hash = '#/inicio'; });
      await page.waitForSelector('.kpi');
      await page.waitForTimeout(400);
    }
    assert.equal(await manejadores(page, '[data-outlet]'), inicial,
      'el outlet debe conservar los mismos manejadores tras navegar');
    await page.close();
  });

  test('un clic abre un solo panel, aunque se haya navegado mucho', async () => {
    const { page } = await abrirSesion();
    for (const piso of ['Piso 4', 'Piso 6', 'Piso 9', 'Piso 11']) {
      await page.locator('.floor-chip', { hasText: piso }).click();
      await page.waitForTimeout(450);
    }
    await page.locator('.room').first().click();
    await page.waitForSelector('.drawer.open');
    await page.waitForTimeout(400);
    assert.equal(await paneles(page), 1, 'sólo debe abrirse un expediente');
    await page.close();
  });

  test('un solo clic fuera lo cierra', async () => {
    const { page } = await abrirSesion();
    await page.locator('.room').first().click();
    await page.waitForSelector('.drawer.open');
    await page.waitForTimeout(400);
    await page.mouse.click(200, 760);
    await page.waitForTimeout(500);
    assert.equal(await paneles(page), 0, 'un clic fuera debe bastar');
    await page.close();
  });

  test('la vista Pisos tampoco duplica el panel', async () => {
    const { page } = await abrirSesion();
    await page.evaluate(() => { location.hash = '#/pisos'; });
    await page.waitForSelector('.rack-grid');
    await page.waitForTimeout(700);
    await page.locator('.room').first().click();
    await page.waitForSelector('.drawer.open');
    await page.waitForTimeout(400);
    assert.equal(await paneles(page), 1);
    await page.close();
  });

  test('se puede cerrar y volver a abrir', async () => {
    const { page } = await abrirSesion();
    await page.locator('.room').first().click();
    await page.waitForSelector('.drawer.open');
    await page.waitForTimeout(350);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    assert.equal(await paneles(page), 0, 'Escape debe cerrar');
    await page.locator('.room').first().click();
    await page.waitForSelector('.drawer.open');
    await page.waitForTimeout(350);
    assert.equal(await paneles(page), 1, 'el guardián debe liberarse al cerrar');
    await page.close();
  });
});

describe('Recorrido de operación', () => {
  test('buscar "618" abre esa habitación', async () => {
    const { page } = await abrirSesion();
    await page.fill('#globalSearch', '618');
    await page.waitForSelector('.search-results button');
    await page.locator('.search-results button').first().click();
    await page.waitForSelector('.drawer.open');
    await page.waitForTimeout(400);
    assert.equal(await paneles(page), 1);
    assert.match(await page.locator('.drawer h2').first().textContent(), /618/);
    await page.close();
  });

  test('registrar una acción actualiza estado e historial', async () => {
    const { page } = await abrirSesion();
    await page.locator('.room').first().click();
    await page.waitForSelector('.drawer.open');
    await page.locator('.drawer [data-tab="accion"]').click();
    await page.waitForSelector('.quick button');
    await page.locator('.quick button', { hasText: 'Reportar mantenimiento' }).click();
    await page.waitForSelector('#actionForm');
    await page.fill('#actionForm [name=comment]', 'Prueba automatizada de interfaz.');
    await page.locator('.modal-foot [type=submit]').click();
    await page.waitForSelector('.toast.ok', { timeout: 10000 });

    await page.locator('.drawer [data-tab="historial"]').click();
    await page.waitForSelector('.tl-card');
    const linea = await page.locator('.timeline').textContent();
    assert.match(linea, /Reportar mantenimiento/);
    assert.match(linea, /Mantenimiento pendiente/, 'el cambio de estado debe verse en el historial');
    await page.close();
  });

  test('la administración expone acciones con etiqueta', async () => {
    const { page } = await abrirSesion();
    await page.evaluate(() => { location.hash = '#/admin'; });
    await page.waitForSelector('.tabs');
    await page.locator('[data-tab="users"]').click();
    await page.waitForSelector('table');
    await page.waitForTimeout(600);
    assert.ok(await page.locator('button[data-edit-user]:has-text("Editar")').count() > 0,
      'cada usuario debe tener un botón "Editar" legible');
    assert.ok(await page.locator('button[data-perms]:has-text("Permisos")').count() > 0,
      'cada rol debe tener un botón "Permisos" legible');
    await page.close();
  });

  test('el modo en bloque selecciona en el rack y aplica a todas de una vez', async () => {
    const { page } = await abrirSesion();
    await page.evaluate(() => { location.hash = '#/pisos'; });
    await page.waitForSelector('.rack-grid');

    await page.locator('[data-bulk]').click();
    await page.waitForSelector('.bulk-bar');

    // En modo bloque el rack selecciona: no debe abrir el expediente.
    const habitaciones = page.locator('.room:not(.inactive)');
    for (let i = 0; i < 3; i += 1) await habitaciones.nth(i).click();
    await page.waitForTimeout(250);
    assert.equal(await paneles(page), 0, 'seleccionar no debe abrir el expediente');
    assert.equal(await page.locator('.room.selected').count(), 3);
    assert.equal(await page.locator('.bulk-count strong').textContent(), '3');

    const numeros = await habitaciones.nth(0).locator('.num').textContent();
    await page.selectOption('.bulk-form [name=accion]', 'mt:CLEAN_DONE');
    await page.fill('.bulk-form [name=comment]', 'Ronda de prueba automatizada.');
    await page.locator('[data-apply]').click();
    await page.waitForSelector('.toast.ok', { timeout: 10000 });
    assert.match(await page.locator('.toast.ok').textContent(), /3 habitaciones actualizadas/);

    // El cambio quedó en cada expediente, no sólo en el aviso.
    await page.locator('[data-bulk]').click();
    await page.waitForTimeout(600);
    await page.locator('.room', { hasText: numeros }).first().click();
    await page.waitForSelector('.drawer.open');
    await page.locator('.drawer [data-tab="historial"]').click();
    await page.waitForSelector('.tl-card');
    assert.match(await page.locator('.timeline').textContent(), /Ronda de prueba automatizada/);
    await page.close();
  });

  test('un reporte a Sistemas se ve en el indicador, en la lista y en el expediente', async () => {
    const { page } = await abrirSesion('amadellaves');
    const indicador = () => page.locator('.kpi', { hasText: 'Incidencias abiertas' }).locator('.n').textContent();
    const antes = Number(await indicador());

    await page.locator('.room').first().click();
    await page.waitForSelector('.drawer.open');
    const numero = (await page.locator('.drawer h2').textContent()).replace(/\D/g, '');
    await page.locator('.drawer [data-tab="accion"]').click();
    await page.waitForSelector('.quick button');
    await page.locator('.quick button', { hasText: 'Reportar a Sistemas' }).click();
    await page.waitForSelector('#actionForm');
    await page.fill('#actionForm [name=comment]', 'Televisión sin señal en el canal 5.');
    await page.locator('.modal-foot [type=submit]').click();
    await page.waitForSelector('.toast.ok', { timeout: 10000 });
    await page.waitForTimeout(1200);

    // El expediente dice CUÁL es la incidencia, no sólo cuántas hay.
    await page.locator('.drawer [data-tab="detalle"]').click();
    await page.waitForSelector('.open-incidents');
    assert.match(await page.locator('.open-incidents').textContent(), /Televisión sin señal/);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    assert.equal(Number(await indicador()), antes + 1, 'el reporte debe sumar en "Incidencias abiertas"');
    assert.match(await page.locator('[data-attention]').textContent(), new RegExp(numero));
    await page.close();
  });

  test('no deja liberar una habitación con un reporte abierto', async () => {
    const { page } = await abrirSesion();
    await page.evaluate(() => { location.hash = '#/pisos'; });
    await page.waitForSelector('.rack-grid');
    await page.locator('.room').nth(4).click();
    await page.waitForSelector('.drawer.open');

    await page.locator('.drawer [data-tab="accion"]').click();
    await page.waitForSelector('.quick button');
    await page.locator('.quick button', { hasText: 'Reportar a Sistemas' }).click();
    await page.waitForSelector('#actionForm');
    await page.fill('#actionForm [name=comment]', 'Caja fuerte trabada.');
    await page.locator('.modal-foot [type=submit]').click();
    await page.waitForSelector('.toast.ok', { timeout: 10000 });
    await page.waitForTimeout(1000);

    // El expediente avisa antes de que nadie lo intente.
    await page.locator('.drawer [data-tab="detalle"]').click();
    await page.waitForSelector('.open-incidents');
    assert.match(await page.locator('.open-incidents').textContent(), /Impide liberar/);

    // Y el servidor lo rechaza, con el motivo a la vista.
    await page.locator('.drawer [data-tab="accion"]').click();
    await page.waitForSelector('.quick button');
    await page.locator('.quick button', { hasText: 'Liberar habitación' }).click();
    await page.waitForSelector('#actionForm');
    await page.fill('#actionForm [name=comment]', 'Se intenta liberar.');
    await page.locator('.modal-foot [type=submit]').click();
    await page.waitForSelector('.toast.error', { timeout: 10000 });
    const aviso = await page.locator('.toast.error').textContent();
    assert.match(aviso, /no puede quedar como/);
    assert.match(aviso, /Caja fuerte trabada/);
    await page.close();
  });

  test('ninguna vista produce errores de JavaScript', async () => {
    const { page, errores } = await abrirSesion();
    for (const vista of ['inicio', 'pisos', 'atencion', 'actividad', 'gerencial', 'reportes', 'auditoria', 'admin']) {
      await page.evaluate((v) => { location.hash = `#/${v}`; }, vista);
      await page.waitForTimeout(900);
      assert.equal(await page.locator('.alert.error').count(), 0, `la vista ${vista} falló al cargar`);
    }
    assert.deepEqual(errores, [], 'la consola no debe registrar errores');
    await page.close();
  });
});
