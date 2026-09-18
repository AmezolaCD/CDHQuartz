import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';
import { ROOT, migrate, isSeeded } from './lib/db.js';
import { loadSettings } from './lib/settings.js';
import { purgeExpiredSessions } from './lib/auth.js';
import { attachUser } from './middleware/auth.js';
import { MovementError } from './lib/movements.js';
import { seed } from './db/seed.js';

import authRoutes from './routes/auth.js';
import ssoRoutes from './routes/sso.js';
import roomRoutes from './routes/rooms.js';
import cleaningRoutes from './routes/cleaning.js';
import dashboardRoutes from './routes/dashboard.js';
import catalogRoutes from './routes/catalog.js';
import adminRoutes from './routes/admin.js';
import reportRoutes from './routes/reports.js';
import integrationRoutes from './routes/integrations.js';

const PORT = Number(process.env.PORT ?? 3000);

/**
 * Prefijo de ruta bajo el que se sirve todo (fase 05 de Core Quartz).
 *
 * Vacío por omisión: **sin `CDH_BASE_PATH` el CDH es idéntico al de siempre**.
 * Con `/cdh` se puede publicar en `core-quartz.vercel.app/cdh/` detrás de las
 * reescrituras de Vercel. Se normaliza aquí para que el resto del archivo no
 * tenga que preocuparse por barras de más.
 */
export const BASE_PATH = normalizarPrefijo(process.env.CDH_BASE_PATH);

function normalizarPrefijo(texto) {
  const crudo = String(texto ?? '').trim();
  if (crudo === '' || crudo === '/') return '';
  const segmentos = crudo.split('/').filter(Boolean);
  if (segmentos.some((s) => !/^[A-Za-z0-9._~-]+$/.test(s))) {
    throw new Error(`CDH_BASE_PATH no es un prefijo válido: ${JSON.stringify(texto)}`);
  }
  return segmentos.map((s) => `/${s}`).join('');
}

migrate();
if (!isSeeded()) {
  console.log('[cdh] Base vacía: cargando catálogo y distribución inicial...');
  seed({ quiet: true });
}
loadSettings();
purgeExpiredSessions();

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

// El prefijo queda al alcance de las rutas (la cookie lo necesita para su
// `Path`), sin que ninguna tenga que volver a leer el entorno.
app.locals.basePath = BASE_PATH;

// Sin prefijo, `rutas` se monta en la raíz y todo queda exactamente igual que
// antes; con prefijo, basta montarlo una vez y nada más cambia de lugar.
const rutas = express.Router();

rutas.use(express.json({ limit: '1mb' }));
rutas.use(express.urlencoded({ extended: true }));
rutas.use(cookieParser());
rutas.use(attachUser);

// La entrada única va **antes** que `/api/auth`: comparte prefijo con el login
// de siempre y tiene que ganarle la ruta `/sso`.
rutas.use('/api/auth/sso', ssoRoutes);
rutas.use('/api/auth', authRoutes);
rutas.use('/api/rooms', roomRoutes);
rutas.use('/api/dashboard', dashboardRoutes);
rutas.use('/api/cleaning', cleaningRoutes);
rutas.use('/api/admin', adminRoutes);
rutas.use('/api/reports', reportRoutes);
rutas.use('/api/integrations', integrationRoutes);
rutas.use('/api', catalogRoutes);

rutas.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'CDH', hotel: 'Hotel Quartz', time: new Date().toISOString() });
});

rutas.use('/api/{*path}', (req, res) => {
  res.status(404).json({ error: `Ruta de API no encontrada: ${req.method} ${req.originalUrl}` });
});

// Interfaz estática (SPA sin proceso de compilación).
// La interfaz no pasa por un compilador, así que los archivos no llevan hash
// en el nombre: con una caché larga, un despliegue nuevo tardaba hasta una
// hora en llegar al navegador. HTML, JS y CSS se revalidan siempre (ETag
// responde 304 y no se retransmiten); las imágenes y fuentes sí se cachean.
//
// `index.html` se sirve a mano —y no como estático— porque lleva un
// `<base href>` que depende del prefijo: la interfaz usa rutas relativas
// (`api/…`, `css/…`) y el enrutador es por `#/`, así que con la base correcta
// todo resuelve bajo el prefijo sin tocar una sola ruta del cliente.
const PAGINA = path.join(ROOT, 'public', 'index.html');
let paginaServida = null;

function paginaConBase() {
  if (paginaServida === null) {
    const html = fs.readFileSync(PAGINA, 'utf8');
    paginaServida = html.replace('<head>', `<head>\n<base href="${BASE_PATH}/">`);
  }
  return paginaServida;
}

const enviarPagina = (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(paginaConBase());
};

rutas.get('/', enviarPagina);

rutas.use(express.static(path.join(ROOT, 'public'), {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    res.setHeader('Cache-Control',
      /\.(html|js|css)$/i.test(filePath) ? 'no-cache' : 'public, max-age=604800');
  },
}));
rutas.get('/{*path}', enviarPagina);

// `GET /cdh` (sin barra final) tiene que llegar a `/cdh/`, o lo relativo del
// `<base>` resolvería un nivel más arriba.
//
// La comprobación mira `originalUrl` a propósito: sin enrutado estricto Express
// trata `/cdh` y `/cdh/` como la misma ruta, así que un redirect a secas se
// redirigía a sí mismo para siempre.
if (BASE_PATH !== '') {
  app.get(BASE_PATH, (req, res, next) => {
    if (req.originalUrl.split('?')[0].endsWith('/')) return next();
    res.redirect(301, `${BASE_PATH}/`);
  });
}
app.use(BASE_PATH === '' ? '/' : BASE_PATH, rutas);

// ------------------------------------------------------- Manejo de errores
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof MovementError) return res.status(err.status).json({ error: err.message });
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'La fotografía excede el tamaño máximo permitido.'
      : `Error al subir archivos: ${err.message}`;
    return res.status(413).json({ error: msg });
  }
  if (err?.message?.startsWith('Formato de imagen no permitido')) {
    return res.status(415).json({ error: err.message });
  }
  if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ error: 'El registro ya existe (valor duplicado).' });
  }
  if (err?.code?.startsWith?.('SQLITE_CONSTRAINT')) {
    return res.status(409).json({ error: `Restricción de integridad: ${err.message}` });
  }
  console.error('[cdh] error no controlado:', err);
  res.status(err?.status ?? 500).json({ error: err?.message ?? 'Error interno del servidor.' });
});

app.listen(PORT, () => {
  console.log(`[cdh] CDH — Control de Detalles por Habitación`);
  console.log(`[cdh] Hotel Quartz · escuchando en http://localhost:${PORT}${BASE_PATH}/`);
});

export default app;
