// Cambio en bloque: la misma acción sobre varias habitaciones del piso.
//
// La selección vive aquí y no en cada vista, porque el rack se vuelve a dibujar
// al cambiar de piso y en cada refresco. El modo se conserva —quien está
// haciendo rondas encadena varios lotes— pero la selección se limpia al cambiar
// de piso: las habitaciones ya no son las mismas.
import { api } from '../api.js';
import { icon } from '../icons.js';
import { $, $$, esc, toast } from '../ui.js';
import { state, can } from '../store.js';

let activo = false;
let pisoActual = null;
const seleccion = new Set();

export const bulkActivo = () => activo;
export const bulkPuedeUsarse = () => can('movement.create');

export function bulkAlternar() {
  activo = !activo;
  if (!activo) seleccion.clear();
  return activo;
}

/** Al cambiar de piso la selección deja de tener sentido. */
export function bulkPiso(floorId) {
  if (pisoActual !== floorId) { seleccion.clear(); pisoActual = floorId; }
}

let cacheAcciones = null;
async function acciones() {
  if (!cacheAcciones) cacheAcciones = await api.get('/api/rooms/meta/quick-actions');
  // Una fotografía es evidencia de UNA habitación concreta, y si el huésped
  // estará dentro se responde habitación por habitación: ninguna de las dos
  // cosas se replica en un lote, así que esas acciones quedan fuera.
  const lista = cacheAcciones.actions.filter((a) => !a.requiresPhoto && !a.asksGuestPresent);
  // El lote se agrupa igual que la pantalla "Registrar": quien opera ve los
  // mismos nombres en el mismo orden, aquí y allá. Un grupo que se quedó sin
  // acciones aplicables en bloque no se ofrece.
  const grupos = cacheAcciones.groups
    .map((g) => ({ ...g, acciones: lista.filter((a) => g.actions.includes(a.code)) }))
    .filter((g) => g.acciones.length);
  return { lista, grupos };
}
export const bulkResetAcciones = () => { cacheAcciones = null; };

/**
 * Monta la barra de selección bajo el rack y mantiene sincronizados los
 * botones de habitación con el conjunto seleccionado.
 *
 * @param {HTMLElement} caja  contenedor donde se dibuja la barra
 * @param {HTMLElement} rack  cuadrícula con los botones [data-room]
 * @param {object[]} rooms    habitaciones del piso (para "seleccionar por estado")
 * @param {Function} onDone   se llama tras aplicar el lote
 */
export async function montarBarraBloque(caja, rack, rooms, onDone) {
  const { lista, grupos } = await acciones();
  const estados = state.statuses ?? [];
  const puedeEstado = can('room.status');
  const tope = state.hotel?.bulkMaxRooms ?? 40;

  // Sólo las habitaciones activas del piso entran en un lote.
  const elegibles = rooms.filter((r) => r.active);
  const porEstado = new Map();
  for (const r of elegibles) {
    if (!porEstado.has(r.status_code)) porEstado.set(r.status_code, { name: r.status_name, color: r.status_color, ids: [] });
    porEstado.get(r.status_code).ids.push(r.id);
  }

  caja.innerHTML = `
    <div class="bulk-bar">
      <div class="bulk-pick">
        <span class="bulk-count"><strong data-n>0</strong> seleccionadas</span>
        <button class="btn sm ghost" data-pick="todas">Todo el piso</button>
        <button class="btn sm ghost" data-pick="ninguna">Ninguna</button>
        ${[...porEstado.entries()].map(([code, g]) =>
          `<button class="chip pick" data-pick-status="${esc(code)}"
             style="color:${esc(g.color)};border-color:${esc(g.color)}55">${esc(g.name)} ${g.ids.length}</button>`).join('')}
      </div>
      <form class="bulk-form" data-form>
        <div class="field">
          <label>Acción</label>
          <select name="accion" required>
            <option value="">Elija la acción a aplicar…</option>
            ${grupos.map((g) => `<optgroup label="${esc(g.name)}">${g.acciones.map((a) =>
              `<option value="mt:${esc(a.code)}">${esc(a.name)}${
                // Sólo se anuncia el destino cuando aporta algo: "Limpieza
                // terminada → Limpieza terminada" no dice nada.
                a.target_status_name && a.target_status_name !== a.name
                  ? ` → ${esc(a.target_status_name)}` : ''}</option>`).join('')}</optgroup>`).join('')}
            ${puedeEstado ? `<optgroup label="Cambiar estado directamente">${estados.map((s) =>
              `<option value="st:${esc(s.code)}">Marcar como ${esc(s.name)}</option>`).join('')}</optgroup>` : ''}
          </select>
        </div>
        <div class="field">
          <label>Comentario <span data-req hidden style="color:var(--danger)">*</span></label>
          <input name="comment" type="text" placeholder="Motivo del cambio (se guarda en cada habitación del lote)">
        </div>
        <button class="btn primary" type="submit" data-apply disabled>${icon('check', 15)} Aplicar</button>
      </form>
      <p class="tiny muted" style="margin:8px 0 0">
        Cada habitación conserva su propio movimiento, su historial y su notificación.
        Hasta ${tope} habitaciones por lote; si una falla, no se registra ninguna.
      </p>
    </div>`;

  const form = $('[data-form]', caja);
  const aplicar = $('[data-apply]', caja);
  const contador = $('[data-n]', caja);
  const req = $('[data-req]', caja);

  const pintar = () => {
    for (const b of $$('[data-room]', rack)) {
      const on = seleccion.has(Number(b.dataset.room));
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', String(on));
    }
    contador.textContent = seleccion.size;
    aplicar.disabled = !seleccion.size || !form.accion.value;
    caja.querySelector('.bulk-bar').classList.toggle('over', seleccion.size > tope);
  };

  // El clic en una habitación lo maneja el rack; aquí sólo se refleja.
  caja.alternarHabitacion = (id) => {
    if (seleccion.has(id)) seleccion.delete(id); else seleccion.add(id);
    pintar();
  };

  caja.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      seleccion.clear();
      if (pick.dataset.pick === 'todas') elegibles.forEach((r) => seleccion.add(r.id));
      return pintar();
    }
    const porSt = e.target.closest('[data-pick-status]');
    if (porSt) {
      const grupo = porEstado.get(porSt.dataset.pickStatus);
      const todos = grupo.ids.every((id) => seleccion.has(id));
      grupo.ids.forEach((id) => (todos ? seleccion.delete(id) : seleccion.add(id)));
      return pintar();
    }
    return undefined;
  });

  form.accion.addEventListener('change', () => {
    const code = form.accion.value.startsWith('mt:') ? form.accion.value.slice(3) : null;
    const a = lista.find((x) => x.code === code);
    req.hidden = !a?.requiresComment;
    form.comment.required = !!a?.requiresComment;
    pintar();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const valor = form.accion.value;
    const cuerpo = {
      roomIds: [...seleccion],
      movementType: valor.startsWith('mt:') ? valor.slice(3) : null,
      status: valor.startsWith('st:') ? valor.slice(3) : null,
      comment: form.comment.value.trim() || null,
    };
    aplicar.disabled = true;
    aplicar.innerHTML = '<span class="spinner"></span> Aplicando…';
    try {
      const r = await api.post('/api/rooms/bulk/movements', cuerpo);
      // El plural de «habitación» pierde el acento: habitaciones, no habitaciónes.
      const n = r.aplicadas.length;
      const omit = r.omitidas.length ? ` · ${r.omitidas.length} omitida${r.omitidas.length === 1 ? '' : 's'}` : '';
      toast(n === 1
        ? `1 habitación actualizada${omit}.`
        : `${n} habitaciones actualizadas${omit}.`);
      seleccion.clear();
      await onDone?.();
    } catch (err) {
      toast(err.message, 'error', 6000);
    } finally {
      aplicar.innerHTML = `${icon('check', 15)} Aplicar`;
      pintar();
    }
  });

  pintar();
  return caja;
}
