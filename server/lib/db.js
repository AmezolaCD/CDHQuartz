import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');
export const DATA_DIR = process.env.CDH_DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = process.env.CDH_DB_FILE || path.join(DATA_DIR, 'cdh.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/**
 * Columnas añadidas después de la primera versión del esquema.
 * `backfill` se ejecuta una sola vez, justo al crear la columna: como hasta
 * ese momento no existía, nadie pudo configurarla y poner el valor previsto
 * no pisa ninguna decisión del administrador.
 */
const COLUMNAS_NUEVAS = [
  {
    table: 'movement_types',
    column: 'cross_department',
    ddl: 'INTEGER NOT NULL DEFAULT 0',
    backfill: "UPDATE movement_types SET cross_department = 1 WHERE code IN ('MAINT_REPORT', 'SYS_REPORT')",
  },
  {
    table: 'movement_types',
    column: 'closes_scope',
    ddl: "TEXT NOT NULL DEFAULT 'categoria'",
    backfill: "UPDATE movement_types SET closes_scope = 'habitacion' WHERE code = 'RELEASE'",
  },
  {
    table: 'categories',
    column: 'blocks_release',
    ddl: 'INTEGER NOT NULL DEFAULT 0',
    backfill: "UPDATE categories SET blocks_release = 1 WHERE code IN ('MTTO', 'SIS')",
  },
  {
    table: 'categories',
    column: 'pending_status_id',
    ddl: 'INTEGER REFERENCES room_statuses(id)',
    backfill: `
      UPDATE categories
         SET pending_status_id = (SELECT id FROM room_statuses WHERE code = 'MANT_PENDIENTE')
       WHERE code = 'MTTO';
      UPDATE categories
         SET pending_status_id = (SELECT id FROM room_statuses WHERE code = 'SIS_PENDIENTE')
       WHERE code = 'SIS'`,
  },
  {
    table: 'room_statuses',
    column: 'requires_vacant',
    ddl: 'INTEGER NOT NULL DEFAULT 0',
    // Sólo el estado de venta exige habitación sin huésped. "Inspeccionada"
    // no: una habitación se limpia e inspecciona con el huésped en casa.
    backfill: "UPDATE room_statuses SET requires_vacant = 1 WHERE code = 'DISPONIBLE'",
  },
  {
    // El relleno de las habitaciones NO va aquí: las ocupaciones del catálogo
    // se insertan después de migrate(), en seed/upgrade, y hasta entonces no
    // hay ninguna fila a la que apuntar.
    table: 'rooms',
    column: 'occupancy_id',
    ddl: 'INTEGER REFERENCES room_occupancies(id)',
  },
  {
    table: 'rooms',
    column: 'occupancy_changed_at',
    ddl: 'TEXT',
  },
  {
    table: 'movement_types',
    column: 'target_occupancy_id',
    ddl: 'INTEGER REFERENCES room_occupancies(id)',
  },
  // El historial es inmutable para UPDATE y DELETE; añadir columnas no lo es:
  // los movimientos ya registrados conservan su contenido y dejan la
  // ocupación en NULL, que es la verdad —entonces no se registraba.
  { table: 'movements', column: 'old_occupancy_id',   ddl: 'INTEGER REFERENCES room_occupancies(id)' },
  { table: 'movements', column: 'new_occupancy_id',   ddl: 'INTEGER REFERENCES room_occupancies(id)' },
  { table: 'movements', column: 'old_occupancy_name', ddl: 'TEXT' },
  { table: 'movements', column: 'new_occupancy_name', ddl: 'TEXT' },
  // El dato del reporte que sustituyó al eje de ocupación: si el huésped
  // estará en la habitación cuando suba el área responsable.
  { table: 'movements', column: 'guest_present', ddl: 'TEXT' },
  { table: 'movement_types', column: 'target_from_clean', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'movement_types', column: 'asks_guest_present', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'room_statuses', column: 'clean_status_id', ddl: 'INTEGER REFERENCES room_statuses(id)' },
  {
    table: 'room_statuses',
    column: 'attention_weight',
    ddl: 'INTEGER NOT NULL DEFAULT 3',
    backfill: `
      UPDATE room_statuses SET attention_weight = 2 WHERE code = 'INSPECCION_PENDIENTE';
      UPDATE room_statuses SET attention_weight = 4
       WHERE code IN ('BLOQUEADA', 'FUERA_SERVICIO', 'REQUIERE_ATENCION')`,
  },
];

/**
 * Índices sobre columnas que no existen en el esquema original. No pueden
 * declararse en schema.sql: ese archivo se ejecuta ANTES de añadir las
 * columnas, así que sobre una base en uso fallaría con "no such column".
 */
const INDICES_TARDIOS = [
  'CREATE INDEX IF NOT EXISTS ix_rooms_occupancy ON rooms(occupancy_id)',
];

export function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schema);
  // CREATE TABLE IF NOT EXISTS no añade columnas a una tabla que ya existe:
  // las bases en uso necesitan este paso para no quedarse atrás.
  for (const c of COLUMNAS_NUEVAS) {
    const existe = db.prepare(`PRAGMA table_info(${c.table})`).all().some((r) => r.name === c.column);
    if (!existe) {
      db.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.ddl}`);
      if (c.backfill) db.exec(c.backfill);
    }
  }
  for (const sql of INDICES_TARDIOS) db.exec(sql);
}

/**
 * Ejecuta `fn` como una única operación atómica.
 * Si cualquier parte falla (estado, movimiento o auditoría) se revierte todo.
 */
export function transaction(fn) {
  return db.transaction(fn);
}

export const one = (sql, params = {}) => db.prepare(sql).get(params);
export const all = (sql, params = {}) => db.prepare(sql).all(params);
export const run = (sql, params = {}) => db.prepare(sql).run(params);

/** Inserta una fila a partir de un objeto plano y devuelve el id nuevo. */
export function insert(table, data) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`;
  const info = db.prepare(sql).run(Object.fromEntries(keys.map((k) => [k, normalize(data[k])])));
  return info.lastInsertRowid;
}

/** Actualiza por id con los campos presentes en `data`. */
export function update(table, id, data) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id`;
  const params = Object.fromEntries(keys.map((k) => [k, normalize(data[k])]));
  return db.prepare(sql).run({ ...params, __id: id }).changes;
}

function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

export function tableExists(name) {
  return !!one(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=@name`, { name });
}

export function isSeeded() {
  return tableExists('rooms') && (one('SELECT COUNT(*) AS n FROM rooms')?.n ?? 0) > 0;
}
