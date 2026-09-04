import { all, one, db } from './db.js';
import { setTimezone } from './time.js';

let cache = null;

export function loadSettings() {
  try {
    cache = Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  } catch {
    // El esquema todavía no existe (arranque en frío): se usan los valores
    // por defecto y se recarga en cuanto la migración termina.
    return {};
  }
  setTimezone(cache.timezone);
  return cache;
}

export function getSetting(key, fallback = null) {
  if (!cache) loadSettings();
  return cache?.[key] ?? fallback;
}

export function getSettingBool(key, fallback = false) {
  const v = getSetting(key, null);
  if (v === null) return fallback;
  return v === '1' || v === 'true';
}

export function getSettingNumber(key, fallback = 0) {
  const n = Number(getSetting(key, null));
  return Number.isFinite(n) ? n : fallback;
}

export function setSettingValue(key, value, userId) {
  db.prepare(
    `UPDATE settings SET value = @value, updated_at = @now, updated_by = @user WHERE key = @key`,
  ).run({ key, value: String(value), now: new Date().toISOString(), user: userId ?? null });
  loadSettings();
}

export function allSettings() {
  return all('SELECT * FROM settings ORDER BY grp, key');
}

export function settingRow(key) {
  return one('SELECT * FROM settings WHERE key = @key', { key });
}

export function invalidateSettings() { cache = null; }
