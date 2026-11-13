// ============================================================================
// Entrada de cambios desde el PMS (Arpón Enterprise) — lógica pura.
//
// El enlace va en UN solo sentido: Arpón avisa y el CDH sigue. Aquí no se
// escribe nada ni se consulta la base; esto decide QUÉ hacer con un evento y
// la ruta se encarga de hacerlo pasando por `recordMovement`, que es la única
// puerta de escritura del sistema.
//
// Que sea puro es deliberado: la regla de precedencia es lo que no se puede
// equivocar, y así se prueba exhaustivamente sin montar un hotel.
// ============================================================================
import { getTimezone } from './time.js';

/** El movimiento con el que se registra todo lo que viene del PMS. */
export const PMS_MOVEMENT_TYPE = 'PMS_EVENT';

/**
 * Los dos estados que el CDH añade y la pantalla de Ama de Llaves de Arpón no
 * maneja. No son etiquetas: detrás de cada uno hay un movimiento `is_incident`
 * con comentario obligatorio, o sea un pendiente abierto, y *Fuera de servicio*
 * además cuenta como bloqueada. Son, literalmente, lo que el CDH sabe y el PMS
 * no, y por eso no los pisa un aviso de afuera.
 */
export const ESTADOS_PROPIOS_DEL_CDH = ['FUERA_SERVICIO', 'DISCREPANCIA'];

/**
 * roomKey de Arpón → número de habitación del CDH.
 *
 * Arpón escribe las 155 con cuatro caracteres y ceros a la izquierda ("0301",
 * "1002"); el CDH las guarda sin rellenar ("301", "1002"). Comprobado contra
 * el entorno de pruebas: las 155 miden exactamente cuatro y coinciden una a
 * una con `FLOOR_MAP`.
 *
 * Se exige el formato en vez de aceptar cualquier cosa que parezca un número:
 * un "415" sin rellenar significaría que Arpón cambió de contrato, y es mejor
 * enterarse por un rechazo que aplicar un cambio sobre una habitación a medias
 * de adivinar.
 */
export function roomNumberFromKey(roomKey) {
  if (typeof roomKey !== 'string' || !/^\d{4}$/.test(roomKey)) {
    return { ok: false, reason: 'formato_de_roomkey' };
  }
  const number = String(parseInt(roomKey, 10));
  // "0000" sería un número 0: no existe ninguna habitación así.
  if (number === '0') return { ok: false, reason: 'formato_de_roomkey' };
  return { ok: true, number };
}

/**
 * ¿Se aplica el estado que llega del PMS?
 *
 * No es una carrera de relojes —gana el más reciente— porque los dos sistemas
 * no saben lo mismo. Arpón manda en los cinco estados que las dos pantallas
 * comparten, que son los de venta y ciclo de habitación. El CDH manda en los
 * dos que añade, mientras el pendiente que los sostiene siga abierto: si una
 * habitación está fuera de servicio por una fuga y Arpón avisa "Disponible
 * limpio", aplicarlo la pone otra vez a la venta.
 *
 * De los dos errores posibles —una habitación vendible que el rack muestra
 * bloqueada, o una averiada que el rack muestra vendible— el segundo le cuesta
 * al hotel un huésped reubicado y el primero unas horas sin vender. Por esa
 * asimetría gana el pendiente abierto.
 *
 * Y la regla se agota sola: en cuanto alguien cierra el pendiente en el CDH
 * ("Mantenimiento completado", "Liberar habitación") la habitación vuelve a los
 * cinco compartidos y Arpón recupera el mando sin que nadie configure nada.
 *
 * Un código que no sea de los conocidos NO se filtra aquí: pasa, y lo rechaza
 * `recordMovement`, que es quien puede comprobarlo contra la tabla de estados
 * y ver si además está activo. Esta función decide precedencia, no existencia.
 */
export function decidePrecedence({ currentStatusCode, incomingStatusCode }) {
  if (!incomingStatusCode) return { apply: false, reason: 'sin_estado' };
  if (incomingStatusCode === currentStatusCode) return { apply: false, reason: 'sin_cambio' };
  if (ESTADOS_PROPIOS_DEL_CDH.includes(currentStatusCode)) {
    return { apply: false, reason: 'estado_propio_del_cdh' };
  }
  return { apply: true, reason: 'aplicado' };
}

/** Desfase de una zona respecto a UTC, en el instante dado. */
function offsetMs(instant, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant)).map((x) => [x.type, x.value]),
  );
  const comoSiFueraUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    p.hour === '24' ? 0 : Number(p.hour), Number(p.minute), Number(p.second),
  );
  return comoSiFueraUtc - instant;
}

/**
 * Marca de tiempo del PMS → epoch en milisegundos.
 *
 * Arpón devuelve fechas SIN zona ("2026-11-13T09:14:00"): lo comprobamos en
 * GetAvailability, que contesta `2026-11-13T00:00:00`. El CDH guarda ISO en UTC
 * (`rooms.status_changed_at`). Comparar las dos tal cual se equivoca por las
 * horas de desfase del hotel —ocho en Tijuana—, y ese error no se ve: descarta
 * cambios buenos por "viejos" o acepta viejos por "nuevos".
 *
 * Así que una fecha sin zona se interpreta en la zona del hotel, y una que sí
 * la trae se respeta. El desfase se calcula en dos pasadas porque depende del
 * instante: el primer tanteo puede caer al otro lado de un cambio de horario.
 */
export function epochFromPmsTimestamp(texto, tz = getTimezone()) {
  if (typeof texto !== 'string' || !texto.trim()) return null;
  const limpio = texto.trim();

  // ¿Trae zona? 'Z' al final, o ±hh:mm después de la hora.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(limpio)) {
    const t = Date.parse(limpio);
    return Number.isFinite(t) ? t : null;
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(limpio);
  if (!m) return null;
  const [, Y, M, D, h, min, s] = m;
  const tanteo = Date.UTC(Number(Y), Number(M) - 1, Number(D), Number(h), Number(min), Number(s ?? 0));
  const primera = tanteo - offsetMs(tanteo, tz);
  return tanteo - offsetMs(primera, tz);
}

/**
 * Instante de un evento del PMS, listo para guardar.
 *
 * Se normaliza a UTC al escribirlo para que dos avisos se puedan comparar sin
 * volver a adivinar el formato: Arpón manda a veces con zona y a veces sin
 * ella. Devuelve null si la fecha no se entiende, y entonces no se guarda nada.
 */
export function pmsEventInstant(changedAt, tz = getTimezone()) {
  const t = epochFromPmsTimestamp(changedAt, tz);
  return t === null ? null : new Date(t).toISOString();
}

/**
 * ¿El evento llegó desordenado, después de uno más nuevo del PMS?
 *
 * Los reintentos del webhook pueden llegar en cualquier orden. Sin esto, un
 * aviso rezagado revive un estado que Arpón ya dejó atrás.
 *
 * SE COMPARA CONTRA EL ÚLTIMO EVENTO DEL PMS, no contra el último cambio de la
 * habitación, y la razón es que los relojes son dos. `changedAt` lo pone
 * Arpón; `rooms.status_changed_at` lo pone el CDH. Compararlos mide la
 * diferencia entre los dos relojes además del orden de los hechos: si Arpón va
 * unos minutos atrasado, todo aviso que llegue poco después de un cambio
 * nuestro se descartaría sin que nada esté mal. Dos marcas de Arpón, en
 * cambio, sí son comparables entre sí.
 *
 * Lo que esta regla NO hace es impedir que un aviso de Arpón pise un cambio
 * reciente del CDH. Eso no es una cuestión de orden sino de autoridad, y la
 * decide `decidePrecedence`: en los cinco estados compartidos manda Arpón,
 * porque es el sistema de registro del hotel, y lo que se captura en el CDH
 * hay que repetirlo allá —es lo que avisa `warns_pms` antes de guardar—.
 * Mezclar las dos reglas vuelve difusas las dos.
 *
 * Ante la duda NO se descarta: sin fecha en el evento, o sin un evento previo
 * contra el que comparar, se procesa. Perder un cambio real es peor que
 * registrar uno de más, que al menos queda visible en el historial.
 */
export function isStalePmsEvent({ changedAt, lastEventAt, tz = getTimezone() }) {
  const evento = epochFromPmsTimestamp(changedAt, tz);
  if (evento === null) return false;
  const anterior = epochFromPmsTimestamp(lastEventAt, tz);
  if (anterior === null) return false;
  return evento < anterior;
}

/**
 * El comentario del movimiento, que es lo único que cuenta la historia cuando
 * el estado NO cambió. Recibe etiquetas ya resueltas: quien llama tiene la
 * tabla de estados a mano y aquí no se consulta nada.
 */
export function pmsComment({ apply, reason, incomingLabel, currentLabel, changedBy, changedAt }) {
  const firma = [changedBy && `usuario ${changedBy}`, changedAt]
    .filter(Boolean).join(', ');
  const origen = `Arpón${firma ? ` (${firma})` : ''}`;
  if (apply) return `${origen} reportó "${incomingLabel}".`;
  return `${origen} reportó "${incomingLabel}"; se conservó "${currentLabel}" (${reason}).`;
}
