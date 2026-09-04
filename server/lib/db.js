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

export function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schema);
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
