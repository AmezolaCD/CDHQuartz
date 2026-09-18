import { api } from '../api.js';
import { icon } from '../icons.js';
import { $, $$, el, esc, emptyState, spinner, statusChip, relative, fmtDate } from '../ui.js';
import { state, can } from '../store.js';
import { navigate } from '../router.js';
import { openRoom } from './room.js';
import { bulkActivo, bulkAlternar, bulkPiso, bulkPuedeUsarse, montarBarraBloque } from './bulk.js';

/** Tarjeta compacta de habitación para el mapa del piso. */
export function roomCard(r) {
  const flags = [];
  // Una limpieza pedida se ve en el rack con el color de su prioridad: quien
  // hace la ronda no debería tener que abrir otra pantalla para saberlo.
  if (r.cleaningRequest) {
    flags.push(`<span class="flag solicitud" style="--pr:${esc(r.cleaningRequest.color)}"
      title="Limpieza solicitada · ${esc(r.cleaningRequest.priority)} — pidió ${esc(r.cleaningRequest.by)}">${
      icon('spray', 10)}${esc(r.cleaningRequest.priority)}</span>`);
  }
  // Un reporte abierto se dice con todas sus letras: un número solo no
  // distingue "hay algo que atender" de "la habitación está fuera de servicio",
  // y son dos cosas muy distintas para quien mira el rack.
  if (r.incidentCount) {
    flags.push(`<span class="flag inc" title="${
      r.incidentCount === 1 ? 'Un reporte abierto' : `${r.incidentCount} reportes abiertos`}">${
      icon('alert', 10)}<span>${r.incidentCount === 1 ? 'Reporte abierto' : `${r.incidentCount} reportes`}</span></span>`);
  }
  if (r.recurrenceCount >= 2) flags.push(`<span class="flag rec" title="Reincidente">${icon('repeat', 10)}${r.recurrenceCount}</span>`);
  if (!r.incidentCount && r.counts_attention) flags.push(`<span class="flag att">${icon('bell', 10)}</span>`);
  return `<button class="room ${r.active ? '' : 'inactive'}" style="--st:${esc(r.status_color)}"
      data-room="${r.id}" title="Habitación ${esc(r.number)} — ${esc(r.status_name)}">
    <span class="num">${esc(r.number)}</span>
    <span class="st">${icon(r.status_icon, 11)}<span>${esc(r.status_name)}</span></span>
    <span class="flags">${flags.join('')}</span>
  </button>`;
}

function kpi(label, value, { accent, sub, target } = {}) {
  return `<div class="kpi" ${accent ? `style="--accent:${esc(accent)}"` : ''}>
    <div class="n">${esc(value)}${target ? `<span class="muted" style="font-size:14px;font-weight:500"> / ${esc(target)}</span>` : ''}</div>
    <div class="l">${esc(label)}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </div>`;
}

/** Fila de indicadores. Se dibuja en cada refresco: si la lista de atención
 *  cambia y los contadores no, la pantalla se contradice a sí misma. */
function kpis(o) {
  return [
    kpi('Habitaciones', o.total, { accent: 'var(--plum-500)', target: o.target !== o.total ? o.target : null,
      sub: o.inactivas ? `${o.inactivas} inactivas` : 'Todas activas' }),
    kpi('Disponibles limpias', o.listas, { accent: 'var(--ok)' }),
    kpi('Limpiezas pedidas', o.solicitudesPendientes ?? 0, { accent: '#7c3aed',
      sub: o.solicitudUrgente ? `la más urgente: ${o.solicitudUrgente}` : 'Nada en cola' }),
    // Con los estados del PMS no hay un "en limpieza": lo que cuenta es lo que
    // le falta a Ama de Llaves por atender.
    kpi('Por limpiar', o.limpieza, { accent: '#0891b2' }),
    kpi('Mantenimiento', o.mantenimiento, { accent: 'var(--warn)' }),
    kpi('Bloqueadas', o.bloqueadas, { accent: '#7f1d1d' }),
    kpi('Pendientes', o.pendientes, { accent: '#d97706' }),
    kpi('Incidencias abiertas', o.incidenciasAbiertas, { accent: 'var(--danger)',
      sub: o.habitacionesConIncidencia === 1 ? '1 habitación' : `${o.habitacionesConIncidencia} habitaciones` }),
    kpi('Movimientos hoy', o.movimientosHoy, { accent: 'var(--info)',
      sub: o.incidenciasHoy ? `${o.incidenciasHoy} incidencias` : 'Sin incidencias' }),
  ].join('');
}

/** Selector de pisos: el dashboard nunca muestra las 155 habitaciones a la vez. */
export function floorBar(floors, selectedId, onSelect) {
  const bar = el('<div class="floor-bar"></div>');
  for (const f of floors) {
    bar.appendChild(el(`<button class="floor-chip" data-floor="${f.id}" aria-current="${f.id === selectedId}">
      <div class="fn">${esc(f.name)}</div>
      <div class="fc">${f.rooms} habitaciones</div>
      ${f.incidencias ? `<div class="alert">${icon('alert', 10)}${f.incidencias} incidencia${f.incidencias > 1 ? 's' : ''}</div>` : ''}
    </button>`));
  }
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-floor]');
    if (b) onSelect(Number(b.dataset.floor));
  });
  return bar;
}

/** Mapa del piso respetando la distribución real del rack. */
export async function renderFloorMap(container, floorId, onRoomChange) {
  container.innerHTML = spinner();
  const data = await api.get(`api/rooms/floors/${floorId}/map`);
  const cells = data.cells.map((c) => (c ? roomCard(c) : '<div class="rack-empty"></div>')).join('');
  bulkPiso(floorId);
  const enBloque = bulkPuedeUsarse() && bulkActivo();

  container.innerHTML = `
    <div class="card ${enBloque ? 'bulk-on' : ''}">
      <div class="card-head">
        <div>
          <h2>${esc(data.floor.name)}</h2>
          <p class="tiny muted" style="margin:3px 0 0">
            ${data.totals.rooms} habitaciones${
              data.totals.cleaningRequests ? ` · ${data.totals.cleaningRequests} con limpieza pedida` : ''}${
              data.totals.attention ? ` · ${data.totals.attention} requieren atención` : ''}
            ${enBloque ? ' · <strong>toque las habitaciones para seleccionarlas</strong>' : ''}
          </p>
        </div>
        <div class="row wrap" style="gap:6px;justify-content:flex-end">
          ${bulkPuedeUsarse() ? `<button class="btn sm ${enBloque ? 'primary' : 'ghost'}" data-bulk>
            ${icon('layers', 14)}${enBloque ? 'Salir de selección' : 'Selección múltiple'}</button>` : ''}
          ${data.statusSummary.map((s) =>
            `<span class="chip" style="color:${esc(s.color)};border-color:${esc(s.color)}33;background:${esc(s.color)}12">
              ${icon(s.icon, 12)}${esc(s.name)} ${s.rooms}</span>`).join('')}
        </div>
      </div>
      <div class="rack">
        <div class="rack-grid" style="grid-template-columns:repeat(${data.columns},minmax(104px,1fr))">${cells}</div>
      </div>
      <div data-bulk-bar></div>
    </div>`;

  const rack = $('.rack-grid', container);
  const cajaBloque = $('[data-bulk-bar]', container);
  if (enBloque) await montarBarraBloque(cajaBloque, rack, data.cells.filter(Boolean), onRoomChange);

  // Esta función se vuelve a llamar al cambiar de piso y en cada refresco,
  // siempre sobre el mismo contenedor. Se reemplaza el manejador anterior en
  // lugar de sumar uno nuevo: acumularlos abría un panel por cada llamada.
  if (container._onRoomClick) container.removeEventListener('click', container._onRoomClick);
  container._onRoomClick = (e) => {
    const alternar = e.target.closest('[data-bulk]');
    if (alternar) {
      bulkAlternar();
      return renderFloorMap(container, floorId, onRoomChange);
    }
    const b = e.target.closest('[data-room]');
    if (!b) return undefined;
    // En modo bloque el rack selecciona; fuera de él, abre el expediente.
    if (enBloque) return cajaBloque.alternarHabitacion(Number(b.dataset.room));
    return openRoom(Number(b.dataset.room), { onChange: onRoomChange });
  };
  container.addEventListener('click', container._onRoomClick);
  return data;
}

export function activityRow(m) {
  return `<button class="list-item" data-room="${m.room_id}">
    <span class="time-col mono">${esc((m.local_time ?? '').slice(0, 5))}</span>
    <span class="lead">${esc(m.room_number)}</span>
    <span class="grow">
      <span class="bold" style="font-size:13px">${esc(m.action)}</span>
      ${m.field_label && m.new_value ? `<span class="small muted"> · ${esc(m.field_label)}: ${esc(m.new_value)}</span>` : ''}
      <div class="tiny muted">${esc(m.department_name ?? 'Sin departamento')} · ${esc(m.user_name)}</div>
    </span>
    ${m.is_incident ? `<span class="chip danger tiny">${icon('alert', 11)}</span>` : ''}
  </button>`;
}

export function attentionRow(item) {
  return `<button class="list-item" data-room="${item.id}">
    <span class="lead" style="color:${esc(item.status_color)}">${esc(item.number)}</span>
    <span class="grow">
      <span class="row wrap" style="gap:5px">
        ${item.reasons.map((r) => `<span class="chip ${
          r.code === 'reincidencia' ? 'warn' : r.code === 'incidencia' || r.code === 'bloqueada' ? 'danger' : 'info'
        } tiny">${esc(r.label)}</span>`).join('')}
      </span>
      <div class="tiny muted" style="margin-top:3px">${esc(item.floor_name)} · ${esc(item.status_name)}${
        item.updated_at ? ` · ${relative(item.updated_at)}` : ''}</div>
    </span>
    ${icon('chevron', 15, 'style="color:var(--ink-4)"')}
  </button>`;
}

// ================================================================= Vista
export async function dashboardView(outlet) {
  const data = await api.get('api/dashboard');
  const o = data.overview;

  outlet.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Panel de operación</h1>
        <p>${esc(state.hotel.name)} · ${o.total} habitaciones activas · ${fmtDate(o.fecha)}</p>
      </div>
      <div class="row wrap">
        ${can('dashboard.manage') ? '<button class="btn" data-go="gerencial">' + icon('chart', 15) + ' Dashboard gerencial</button>' : ''}
        ${can('history.view') ? '<button class="btn" data-go="actividad">' + icon('history', 15) + ' Ver toda la actividad</button>' : ''}
      </div>
    </div>

    <div class="kpis" data-kpis>${kpis(o)}</div>

    <section style="margin-bottom:18px">
      <div class="row-between" style="margin-bottom:8px">
        <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2)">Seleccione un piso</h2>
        <span class="tiny muted">${state.floors.length} pisos</span>
      </div>
      <div data-floors></div>
      <div data-map></div>
    </section>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px">
      <section class="card">
        <div class="card-head">
          <h2>Requiere atención</h2>
          <div class="row" style="gap:8px">
            <span class="chip ${data.attention.total ? 'danger' : 'ok'}" data-attention-count>${data.attention.total}</span>
            ${data.attention.total > data.attention.items.length ? '<button class="btn sm ghost" data-go="atencion">Ver todo</button>' : ''}
          </div>
        </div>
        <div class="card-body flush"><div class="list" data-attention>
          ${data.attention.items.length ? data.attention.items.map(attentionRow).join('')
            : emptyState('Nada requiere atención en este momento.', 'check-circle')}
        </div></div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Actividad reciente</h2>
          ${can('history.view') ? '<button class="btn sm ghost" data-go="actividad">Ver todo</button>' : ''}
        </div>
        <div class="card-body flush"><div class="list" data-activity>
          ${data.activity.items.length ? data.activity.items.map(activityRow).join('')
            : emptyState('Sin movimientos registrados todavía.', 'history')}
        </div></div>
      </section>
    </div>`;

  const mapBox = $('[data-map]', outlet);
  const refresh = async () => {
    const fresh = await api.get('api/dashboard');
    $('[data-kpis]', outlet).innerHTML = kpis(fresh.overview);
    const cuenta = $('[data-attention-count]', outlet);
    cuenta.textContent = fresh.attention.total;
    cuenta.className = `chip ${fresh.attention.total ? 'danger' : 'ok'}`;
    $('[data-attention]', outlet).innerHTML = fresh.attention.items.length
      ? fresh.attention.items.map(attentionRow).join('')
      : emptyState('Nada requiere atención en este momento.', 'check-circle');
    $('[data-activity]', outlet).innerHTML = fresh.activity.items.length
      ? fresh.activity.items.map(activityRow).join('')
      : emptyState('Sin movimientos registrados todavía.', 'history');
    await renderFloorMap(mapBox, state.selectedFloorId, refresh);
  };

  const bar = floorBar(data.floors, state.selectedFloorId, async (id) => {
    state.selectedFloorId = id;
    $$('[data-floor]', bar).forEach((b) => b.setAttribute('aria-current', String(Number(b.dataset.floor) === id)));
    await renderFloorMap(mapBox, id, refresh);
  });
  $('[data-floors]', outlet).appendChild(bar);
  await renderFloorMap(mapBox, state.selectedFloorId ?? data.floors[0]?.id, refresh);

  outlet.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) return navigate(go.dataset.go);
    const room = e.target.closest('.list [data-room]');
    if (room) openRoom(Number(room.dataset.room), { onChange: refresh });
    return undefined;
  });
}
