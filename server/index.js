import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import multer from 'multer';
import { ROOT, migrate, isSeeded } from './lib/db.js';
import { loadSettings } from './lib/settings.js';
import { purgeExpiredSessions } from './lib/auth.js';
import { attachUser } from './middleware/auth.js';
import { MovementError } from './lib/movements.js';
import { seed } from './db/seed.js';

import authRoutes from './routes/auth.js';
import roomRoutes from './routes/rooms.js';
import dashboardRoutes from './routes/dashboard.js';
import catalogRoutes from './routes/catalog.js';
import adminRoutes from './routes/admin.js';
import reportRoutes from './routes/reports.js';
import integrationRoutes from './routes/integrations.js';

const PORT = Number(process.env.PORT ?? 3000);

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

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(attachUser);

app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api', catalogRoutes);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'CDH', hotel: 'Hotel Quartz', time: new Date().toISOString() });
});

app.use('/api/{*path}', (req, res) => {
  res.status(404).json({ error: `Ruta de API no encontrada: ${req.method} ${req.originalUrl}` });
});

// Interfaz estática (SPA sin proceso de compilación).
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: '1h' }));
app.get('/{*path}', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

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
  console.log(`[cdh] Hotel Quartz · escuchando en http://localhost:${PORT}`);
});

export default app;
