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
    await page.check('#actionForm [name=guestPresent][value=si]');
    await page.fill('#actionForm [name=comment]', 'Prueba automatizada de interfaz.');
    await page.locator('.modal-foot [type=submit]').click();
    await page.waitForSelector('.toast.ok', { timeout: 10000 });

    await page.locator('.drawer [data-tab="historial"]').click();
    await page.waitForSelector('.tl-card');
    const linea = await page.locator('.timeline').textContent();
    assert.match(linea, /Reportar mantenimiento/);
    assert.match(linea, /Fuera de servicio/, 'el cambio de estado debe verse en el historial');
    assert.match(linea, /El huésped estaría en la habitación/,
      'el historial conserva lo que el reporte dijo del huésped');
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
    for (const i of [1, 2, 3]) await habitaciones.nth(i).click();
    await page.waitForTimeout(250);
    assert.equal(await paneles(page), 0, 'seleccionar no debe abrir el expediente');
    assert.equal(await page.locator('.room.selected').count(), 3);
    assert.equal(await page.locator('.bulk-count strong').textContent(), '3');

    const numeros = await habitaciones.nth(1).locator('.num').textContent();
    // Una habitación se limpia cuando lo espera: se ponen "Salida" primero.
    await page.selectOption('.bulk-form [name=accion]', 'st:SALIDA');
    await page.locator('[data-apply]').click();
    await page.waitForSelector('.toast.ok', { timeout: 10000 });
    await page.waitForTimeout(900);
    for (const i of [1, 2, 3]) await habitaciones.nth(i).click();
    await page.waitForTimeout(250);
    await page.selectOption('.bulk-form [name=accion]', 'mt:CLEAN_DONE');
    await page.fill('.bulk-form [name=comment]', 'Ronda de prueba automatizada.');
    await page.locator('[data-apply]').click();
    await page.waitForSelector('.toast.ok', { timeout: 10000 });
    // Son dos avisos encadenados —el de "Salida" y el de la limpieza—: se mira
    // el último, que es el del lote que interesa.
    assert.match(await page.locator('.toast.ok').last().textContent(), /3 habitaciones actualizadas/);

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
    await page.check('#actionForm [name=guestPresent][value=si]');
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
    await page.check('#actionForm [name=guestPresent][value=no]');
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

  test('marcar un campo en falla retira la habitación de la venta', async () => {
    const { page } = await abrirSesion();
    await page.evaluate(() => { location.hash = '#/pisos'; });
    await page.waitForSelector('.rack-grid');

    const tarjeta = page.locator('.room:not(.inactive)').nth(7);
    const numero = (await tarjeta.locator('.num').textContent()).trim();
    assert.match(await tarjeta.locator('.st').textContent(), /Disponible limpio/);

    await tarjeta.click();
    await page.waitForSelector('.drawer.open');
    // El campo Plomería vive en la categoría Mantenimiento del expediente.
    await page.locator('.detail-cat', { hasText: 'Mantenimiento' }).locator('summary').click();
    await page.waitForTimeout(300);
    const fila = page.locator('.dfield', { hasText: 'Plomería' }).first();
    await fila.locator('[data-edit="plomeria"]').click();
    await page.waitForSelector('#fieldForm');
    await page.selectOption('#fieldForm [name=value]', 'Falla');
    await page.locator('.modal-foot [type=submit]').click();
    await page.waitForSelector('.toast.ok', { timeout: 10000 });
    await page.waitForTimeout(1200);

    const chip = await page.locator('.drawer .chip').first().textContent();
    assert.match(chip, /Fuera de servicio/, `la habitación ${numero} quedó en "${chip.trim()}"`);
    await page.close();
  });

  test('el reporte pregunta por el huésped y no deja guardarlo sin respuesta', async () => {
    const { page } = await abrirSesion('amadellaves');
    await page.evaluate(() => { location.hash = '#/pisos'; });
    await page.waitForSelector('.rack-grid');
    await page.locator('.room:not(.inactive)').nth(10).click();
    await page.waitForSelector('.drawer.open');
    await page.locator('.drawer [data-tab="accion"]').click();
    await page.waitForSelector('.quick button');
    await page.locator('.quick button', { hasText: 'Reportar a Sistemas' }).click();
    await page.waitForSelector('#actionForm');

    // La pregunta está, y el formulario no se envía sin contestarla.
    assert.equal(await page.locator('#actionForm [name=guestPresent]').count(), 3);
    await page.fill('#actionForm [name=comment]', 'La TV no enciende.');
    await page.locator('.modal-foot [type=submit]').click();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.toast.ok').count(), 0, 'no debe guardarse sin contestar');

    await page.check('#actionForm [name=guestPresent][value=no]');
    await page.locator('.modal-foot [type=submit]').click();
    await page.waitForSelector('.toast.ok', { timeout: 10000 });
    await page.waitForTimeout(900);

    await page.locator('.drawer [data-tab="historial"]').click();
    await page.waitForSelector('.tl-card');
    assert.match(await page.locator('.timeline').textContent(), /La habitación estaría libre/);
    await page.close();
  });

  test('ningún nombre de estado se recorta en la tarjeta', async () => {
    // `textContent` devuelve el texto completo aunque la pantalla lo esté
    // cortando, así que una prueba que sólo lo compare no ve el recorte. Y
    // recortados, "Ocupado limpio" y "Ocupado sucio" se leen igual.
    const { page } = await abrirSesion();
    await page.evaluate(() => { location.hash = '#/pisos'; });
    await page.waitForSelector('.rack-grid');
    await page.waitForTimeout(500);

    const cortadas = await page.evaluate(() => [...document.querySelectorAll('.room')]
      .map((tarjeta) => {
        const st = tarjeta.querySelector('.st');
        if (!st) return { texto: tarjeta.querySelector('.num')?.textContent, motivo: 'sin estado' };
        const caja = tarjeta.getBoundingClientRect();
        const suya = st.getBoundingClientRect();
        if (st.scrollWidth > st.clientWidth + 1) return { texto: st.textContent.trim(), motivo: 'texto recortado' };
        if (suya.right > caja.right + 1 || suya.bottom > caja.bottom + 1) {
          return { texto: st.textContent.trim(), motivo: 'se sale de la tarjeta' };
        }
        return null;
      })
      .filter(Boolean));

    assert.deepEqual(cortadas, [], 'toda habitación debe mostrar su estado completo');
    await page.close();
  });

  test('un lote no puede replicar la respuesta sobre el huésped', async () => {
    // La respuesta es de UNA habitación concreta, así que esas acciones no
    // aparecen en el modo en bloque.
    const { page } = await abrirSesion();
    await page.evaluate(() => { location.hash = '#/pisos'; });
    await page.waitForSelector('.rack-grid');
    await page.locator('[data-bulk]').click();
    await page.waitForSelector('.bulk-bar');
    const opciones = await page.locator('.bulk-form [name=accion] option').allTextContents();
    assert.ok(!opciones.some((o) => /Reportar a Sistemas|Reportar mantenimiento/.test(o)),
      `los reportes no deben ofrecerse en bloque: ${opciones.join(' | ')}`);
    assert.ok(opciones.some((o) => /Limpieza terminada/.test(o)));
    await page.close();
  });

  test('el centro de limpieza ordena la cola y avisa del PMS', async () => {
    const { page } = await abrirSesion('recepcion');
    await page.evaluate(() => { location.hash = '#/limpieza'; });
    await page.waitForSelector('[data-cola]');
    await page.waitForTimeout(700);

    // El aviso de que el cambio hay que repetirlo en Arpón está a la vista.
    assert.match(await page.locator('.pms-notice').first().textContent(), /Arpón Enterprise/);

    for (const [numero, prioridad] of [['1001', 'BAJA'], ['1002', 'URGENTE'], ['1003', 'ALTA']]) {
      await page.locator('[data-pedir]').click();
      await page.waitForSelector('#pedirForm');
      await page.fill('#pedirForm [name=numero]', numero);
      await page.check(`#pedirForm [name=priority][value=${prioridad}]`);
      await page.locator('.modal-foot [type=submit]').click();
      await page.waitForSelector('.toast.ok', { timeout: 10000 });
      await page.waitForTimeout(700);
    }

    // La cola se ordena sola: urgente, alta, baja.
    const orden = await page.locator('[data-cola] .solic .num').allTextContents();
    assert.deepEqual(orden.slice(0, 3), ['1002', '1003', '1001'], `quedó: ${orden.join(', ')}`);

    // Una habitación con limpieza pedida no se ofrece para entregar.
    const listas = await page.locator('[data-listas] .solic .num').allTextContents();
    assert.ok(!listas.includes('1002'), 'con limpieza pendiente no está para entregarse');
    await page.close();
  });

  test('entregar una habitación limpia avisa del PMS antes de guardar', async () => {
    const { page } = await abrirSesion('recepcion');
    await page.evaluate(() => { location.hash = '#/limpieza'; });
    await page.waitForSelector('[data-listas] .solic');
    await page.waitForTimeout(600);

    const numero = (await page.locator('[data-listas] .solic .num').first().textContent()).trim();
    await page.locator('[data-entregar]').first().click();
    await page.waitForSelector('#entregarForm');
    assert.match(await page.locator('#entregarForm .pms-notice').textContent(), /Arpón Enterprise/,
      'el aviso tiene que verse ANTES de guardar, no después');

    await page.locator('.modal-foot [type=submit]').click();
    await page.waitForSelector('.toast', { timeout: 10000 });
    await page.waitForTimeout(900);

    // Y quedó en Entrada nueva, fuera de la venta.
    await page.evaluate(() => { location.hash = '#/pisos'; });
    await page.waitForSelector('.rack-grid');
    await page.waitForTimeout(600);
    const tarjeta = page.locator('.room', { hasText: numero }).first();
    assert.match(await tarjeta.locator('.st').textContent(), /Entrada nueva/);
    await page.close();
  });

  test('ninguna vista produce errores de JavaScript', async () => {
    const { page, errores } = await abrirSesion();
    for (const vista of ['inicio', 'pisos', 'limpieza', 'atencion', 'actividad', 'gerencial', 'reportes', 'auditoria', 'admin']) {
      await page.evaluate((v) => { location.hash = `#/${v}`; }, vista);
      await page.waitForTimeout(900);
      assert.equal(await page.locator('.alert.error').count(), 0, `la vista ${vista} falló al cargar`);
    }
    assert.deepEqual(errores, [], 'la consola no debe registrar errores');
    await page.close();
  });
});
