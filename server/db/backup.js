// ============================================================================
// npm run backup — copia en caliente de la base, sin detener el servicio.
//
// Copiar el archivo .sqlite con `cp` mientras el servidor escribe produce una
// copia rota: el modo WAL deja parte de los datos en archivos aparte. Aquí se
// usa la copia de seguridad en línea de SQLite, que produce un archivo único y
// consistente aunque haya escrituras en curso.
//
//   npm run backup                      # a data/backups/, con la fecha
//   npm run backup -- /ruta/destino.sqlite
//   npm run backup -- --keep=30         # conserva los últimos 30 respaldos
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from '../lib/db.js';
import { stamp } from '../lib/time.js';
import { esEjecutadoDirectamente } from '../lib/cli.js';

const arg = (nombre, fb) => {
  const p = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.slice(nombre.length + 3) : fb;
};

export async function backup({ destino = null, keep = 14, quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const t = stamp();
  const dir = destino ? path.dirname(destino) : path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });

  const archivo = destino
    ?? path.join(dir, `cdh-${t.localDate}-${t.localTime.replace(/:/g, '')}.sqlite`);

  await db.backup(archivo);
  const mb = (fs.statSync(archivo).size / 1048576).toFixed(1);
  log(`[backup] ${archivo} · ${mb} MB · ${t.localDate} ${t.localTime} (${t.timezone})`);

  // Rotación: sólo toca los respaldos con nombre propio de esta herramienta.
  let borrados = 0;
  if (!destino && keep > 0) {
    const previos = fs.readdirSync(dir)
      .filter((f) => /^cdh-\d{4}-\d{2}-\d{2}-\d{6}\.sqlite$/.test(f))
      .sort()
      .reverse();
    for (const viejo of previos.slice(keep)) {
      fs.unlinkSync(path.join(dir, viejo));
      borrados += 1;
    }
    if (borrados) log(`[backup] ${borrados} respaldo(s) antiguo(s) retirado(s); se conservan ${keep}.`);
  }
  return { archivo, borrados };
}

if (esEjecutadoDirectamente(import.meta.url)) {
  const posicional = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? null;
  backup({ destino: posicional, keep: Number(arg('keep', 14)) })
    .catch((e) => { console.error(`[backup] Falló: ${e.message}`); process.exit(1); });
}
