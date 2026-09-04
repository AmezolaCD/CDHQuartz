import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, UPLOAD_DIR } from '../lib/db.js';

for (const f of ['cdh.sqlite', 'cdh.sqlite-wal', 'cdh.sqlite-shm']) {
  const p = path.join(DATA_DIR, f);
  if (fs.existsSync(p)) { fs.rmSync(p); console.log('[reset] eliminado', f); }
}
if (fs.existsSync(UPLOAD_DIR)) {
  for (const f of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, f), { recursive: true, force: true });
  console.log('[reset] uploads vaciados');
}
console.log('[reset] Ejecute `npm run seed` para volver a cargar el catálogo.');
