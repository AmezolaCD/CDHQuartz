import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { UPLOAD_DIR } from './db.js';
import { getSettingNumber } from './settings.js';
import { localDate } from './time.js';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif' };

const storage = multer.diskStorage({
  destination(req, file, cb) {
    // Se agrupan por fecha local del hotel para facilitar respaldos.
    const dir = path.join(UPLOAD_DIR, localDate(0));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${EXT[file.mimetype] ?? '.bin'}`);
  },
});

export const photoUpload = multer({
  storage,
  limits: {
    fileSize: Math.max(1, getSettingNumber('max_photo_mb', 8)) * 1024 * 1024,
    files: 8,
  },
  fileFilter(req, file, cb) {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(new Error(`Formato de imagen no permitido: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

/** Convierte los archivos de multer al formato que espera recordMovement. */
export function toPhotoRecords(files = [], kinds = {}) {
  return files.map((f, i) => ({
    filename: path.join(path.basename(path.dirname(f.path)), f.filename),
    originalName: f.originalname,
    mimeType: f.mimetype,
    size: f.size,
    kind: kinds[String(i)] ?? kinds[f.fieldname] ?? 'general',
  }));
}

/** Borra del disco los archivos de una petición fallida (la transacción revirtió). */
export function discardFiles(files = []) {
  for (const f of files) {
    try { fs.rmSync(f.path, { force: true }); } catch { /* archivo ya ausente */ }
  }
}

export function photoPath(filename) {
  const full = path.resolve(UPLOAD_DIR, filename);
  if (!full.startsWith(path.resolve(UPLOAD_DIR))) return null; // evita salir del directorio
  return fs.existsSync(full) ? full : null;
}
