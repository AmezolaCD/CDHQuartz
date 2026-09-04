// Sello de tiempo del SERVIDOR. Nunca se confía en el reloj del navegador.
// La zona horaria del hotel es configurable (settings.timezone).

let currentTimezone = process.env.CDH_TZ || 'America/Mexico_City';

export function setTimezone(tz) {
  if (!tz) return;
  try {
    new Intl.DateTimeFormat('es-MX', { timeZone: tz }).format(new Date());
    currentTimezone = tz;
  } catch {
    console.warn(`[cdh] Zona horaria inválida ignorada: ${tz}`);
  }
}

export function getTimezone() {
  return currentTimezone;
}

const partsCache = new Map();
function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }));
  }
  return partsCache.get(tz);
}

/** Instantánea temporal completa generada por el servidor. */
export function stamp(date = new Date(), tz = currentTimezone) {
  const parts = Object.fromEntries(
    formatter(tz).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    iso: date.toISOString(),
    epoch: date.getTime(),
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${hour}:${parts.minute}:${parts.second}`,
    timezone: tz,
  };
}

/** Fecha local del hotel (YYYY-MM-DD) desplazada `days` días. */
export function localDate(days = 0, tz = currentTimezone) {
  return stamp(new Date(Date.now() + days * 86400000), tz).localDate;
}

/** Rango [desde, hasta] en fechas locales para periodos comunes. */
export function periodRange(period, tz = currentTimezone) {
  const today = localDate(0, tz);
  switch (period) {
    case 'hoy':      return { from: today, to: today };
    case 'ayer':     return { from: localDate(-1, tz), to: localDate(-1, tz) };
    case 'semana':   return { from: localDate(-6, tz), to: today };
    case 'mes':      return { from: localDate(-29, tz), to: today };
    case 'trimestre':return { from: localDate(-89, tz), to: today };
    case 'anio':     return { from: localDate(-364, tz), to: today };
    case 'todo':     return { from: '0000-01-01', to: '9999-12-31' };
    default:         return { from: localDate(-29, tz), to: today };
  }
}
