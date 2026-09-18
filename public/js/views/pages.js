import { api, download } from '../api.js';
import { icon } from '../icons.js';
import { $, $$, el, esc, emptyState, spinner, toast, relative, fmtDate } from '../ui.js';
import { state, can } from '../store.js';
import { openRoom } from './room.js';
import { floorBar, renderFloorMap, activityRow, attentionRow } from './dashboard.js';

// Abre el expediente desde listas y tablas. Se excluye la cuadrícula del
// rack: ésa la maneja renderFloorMap, y atender ambas abría dos paneles.
const bindRooms = (outlet, refresh) => outlet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-room]');
  if (b && !b.closest('.rack-grid')) openRoom(Number(b.dataset.room), { onChange: refresh });
});

// ============================================================ Pisos y mapa
export async function floorsView(outlet, route) {
  const floorId = Number(route.params[0]) || state.selectedFloorId || state.floors[0]?.id;
  state.selectedFloorId = floorId;

  outlet.innerHTML = `
    <div class="page-head">
      <div><h1>Mapa por piso</h1><p>Distribución real del rack. Toque una habitación para abrir su expediente,
        o active la selección múltiple para cambiar varias de una vez.</p></div>
    </div>
    <div data-floors></div>
    <div data-summary style="margin-bottom:16px"></div>
    <div data-map></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;margin-top:16px">
      <section class="card"><div class="card-head"><h2>Requiere atención en este piso</h2></div>
        <div class="card-body flush"><div class="list" data-attention></div></div></section>
      <section class="card"><div class="card-head"><h2>Actividad del piso</h2></div>
        <div class="card-body flush"><div class="list" data-activity></div></div></section>
    </div>`;

  const load = async (id) => {
    state.selectedFloorId = id;
    history.replaceState(null, '', `#/pisos/${id}`);
    const [dash] = await Promise.all([api.get(`api/dashboard/floor/${id}`)]);
    const s = dash.summary ?? {};
    $('[data-summary]', outlet).innerHTML = `
      <div class="kpis" style="margin:0">
        ${[['Habitaciones', s.rooms ?? 0, 'var(--plum-500)'], ['Listas', s.listas ?? 0, 'var(--ok)'],
           ['En limpieza', s.limpieza ?? 0, '#0891b2'], ['Mantenimiento', s.mantenimiento ?? 0, 'var(--warn)'],
           ['Bloqueadas', s.bloqueadas ?? 0, '#7f1d1d'], ['Incidencias', s.incidencias ?? 0, 'var(--danger)']]
          .map(([l, v, c]) => `<div class="kpi" style="--accent:${c}"><div class="n">${v}</div><div class="l">${l}</div></div>`).join('')}
      </div>`;
    $('[data-attention]', outlet).innerHTML = dash.attention.items.length
      ? dash.attention.items.map(attentionRow).join('')
      : emptyState('Ninguna habitación de este piso requiere atención.', 'check-circle');
    $('[data-activity]', outlet).innerHTML = dash.activity.items.length
      ? dash.activity.items.map(activityRow).join('')
      : emptyState('Sin movimientos en este piso.', 'history');
    await renderFloorMap($('[data-map]', outlet), id, () => load(id));
  };

  const floors = (await api.get('api/dashboard')).floors;
  const bar = floorBar(floors, floorId, (id) => {
    $$('[data-floor]', bar).forEach((b) => b.setAttribute('aria-current', String(Number(b.dataset.floor) === id)));
    load(id);
  });
  $('[data-floors]', outlet).appendChild(bar);
  await load(floorId);
  bindRooms(outlet, () => load(state.selectedFloorId));
}

// ======================================================== Requiere atención
export async function attentionView(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div><h1>Requiere atención</h1><p>Sólo lo accionable: bloqueos, mantenimiento, inspecciones, incidencias y reincidencias.</p></div>
    </div>
    <div class="card"><div class="card-body flush"><div class="list" data-list>${spinner()}</div></div></div>`;

  const load = async () => {
    const data = await api.get('api/dashboard/attention', { limit: 200 });
    $('[data-list]', outlet).innerHTML = data.items.length
      ? data.items.map(attentionRow).join('')
      : emptyState('Ninguna habitación requiere atención en este momento.', 'check-circle');
  };
  await load();
  bindRooms(outlet, load);
}

// ============================================================== Actividad
export async function activityView(outlet) {
  const filters = { from: '', to: '', floorId: '', departmentId: '', userId: '', categoryId: '', incidentsOnly: '' };
  let offset = 0;

  outlet.innerHTML = `
    <div class="page-head"><div><h1>Actividad reciente</h1>
      <p>Últimos movimientos del hotel. Hora, habitación, departamento y acción.</p></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-body">
      <div class="grid-2">
        <div class="field"><label>Desde</label><input type="date" data-f="from"></div>
        <div class="field"><label>Hasta</label><input type="date" data-f="to"></div>
        <div class="field"><label>Piso</label><select data-f="floorId"><option value="">Todos</option>
          ${state.floors.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Departamento</label><select data-f="departmentId"><option value="">Todos</option>
          ${state.departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Usuario</label><select data-f="userId"><option value="">Todos</option>
          ${state.users.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}</select></div>
        <div class="field"><label>Sólo incidencias</label><select data-f="incidentsOnly">
          <option value="">No</option><option value="true">Sí</option></select></div>
      </div>
    </div></div>
    <div class="card"><div class="card-head"><h2>Movimientos</h2><span class="tiny muted" data-count></span></div>
      <div class="card-body flush"><div class="list" data-list></div></div>
      <div class="card-body center" data-more hidden><button class="btn" data-load-more>Cargar más</button></div>
    </div>`;

  const list = $('[data-list]', outlet);
  const load = async (append = false) => {
    if (!append) { offset = 0; list.innerHTML = spinner(); }
    const data = await api.get('api/dashboard/activity', { ...filters, limit: 50, offset });
    const html = data.items.map(activityRow).join('');
    if (append) list.insertAdjacentHTML('beforeend', html);
    else list.innerHTML = html || emptyState('Sin movimientos para los filtros seleccionados.', 'history');
    $('[data-count]', outlet).textContent = `${data.total} en total`;
    offset += data.items.length;
    $('[data-more]', outlet).hidden = offset >= data.total;
  };

  outlet.addEventListener('change', (e) => {
    if (e.target.dataset.f) { filters[e.target.dataset.f] = e.target.value; load(); }
  });
  $('[data-load-more]', outlet).addEventListener('click', () => load(true));
  await load();
  bindRooms(outlet, () => load());
}

// ====================================================== Dashboard gerencial
export async function managementView(outlet) {
  outlet.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard gerencial</h1><p>Información accionable del hotel.</p></div>
      <select data-period style="max-width:180px">
        <option value="hoy">Hoy</option><option value="semana">Últimos 7 días</option>
        <option value="mes" selected>Últimos 30 días</option><option value="trimestre">Últimos 90 días</option>
      </select>
    </div>
    <div data-content>${spinner()}</div>`;

  const load = async (period) => {
    const d = await api.get('api/dashboard/gerencial', { period });
    const o = d.overview;
    const maxTrend = Math.max(1, ...d.trend.map((t) => t.movimientos));

    $('[data-content]', outlet).innerHTML = `
      <div class="kpis">
        ${[['Total habitaciones', o.total, 'var(--plum-500)'], ['Listas', o.listas, 'var(--ok)'],
           ['En limpieza', o.limpieza, '#0891b2'], ['Mantenimiento', o.mantenimiento, 'var(--warn)'],
           ['Bloqueadas', o.bloqueadas, '#7f1d1d'], ['Pendientes', o.pendientes, '#d97706'],
           ['Incidencias abiertas', o.incidenciasAbiertas, 'var(--danger)'], ['Movimientos hoy', o.movimientosHoy, 'var(--info)']]
          .map(([l, v, c]) => `<div class="kpi" style="--accent:${c}"><div class="n">${v}</div><div class="l">${l}</div></div>`).join('')}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:16px">
        <section class="card"><div class="card-head"><h2>Problemas por piso</h2></div>
          <div class="card-body flush"><div class="table-scroll"><table>
            <thead><tr><th>Piso</th><th>Hab.</th><th>Listas</th><th>Mtto.</th><th>Bloq.</th><th>Incid.</th></tr></thead>
            <tbody>${d.floors.map((f) => `<tr>
              <td><button class="btn sm ghost" data-floor-go="${f.id}" style="padding:0;min-height:auto">${esc(f.name)}</button></td>
              <td class="mono">${f.rooms}</td><td class="mono">${f.listas ?? 0}</td>
              <td class="mono">${f.mantenimiento ?? 0}</td><td class="mono">${f.bloqueadas ?? 0}</td>
              <td class="mono ${f.incidencias ? 'bold' : ''}" style="${f.incidencias ? 'color:var(--danger)' : ''}">${f.incidencias}</td>
            </tr>`).join('')}</tbody></table></div></div></section>

        <section class="card"><div class="card-head">
          <div><h2>Por departamento</h2>
            <p class="tiny muted" style="margin:3px 0 0">${fmtDate(d.range.from)} — ${fmtDate(d.range.to)}</p></div></div>
          <div class="card-body flush">${d.departments.length ? `<div class="table-scroll"><table>
            <thead><tr><th>Departamento</th><th>Movimientos</th><th>Incidencias</th><th>Críticas</th></tr></thead>
            <tbody>${d.departments.map((x) => `<tr><td>${esc(x.departamento)}</td>
              <td class="mono">${x.movimientos}</td><td class="mono">${x.incidencias ?? 0}</td>
              <td class="mono">${x.criticas ?? 0}</td></tr>`).join('')}</tbody></table></div>`
            : emptyState('Sin movimientos en el periodo.')}</div></section>

        <section class="card"><div class="card-head" style="align-items:flex-start">
          <h2 style="white-space:nowrap">Reincidentes</h2>
          <div class="row wrap" style="gap:5px;justify-content:flex-end">${d.recurrence.buckets.map((b) =>
            `<span class="chip ${b.rooms ? 'warn' : ''} tiny">${esc(b.label)}: ${b.rooms}</span>`).join('')}</div></div>
          <div class="card-body flush">${d.recurrence.rooms.length ? `<div class="list">
            ${d.recurrence.rooms.map((r) => `<button class="list-item" data-room="${r.room_id}">
              <span class="lead">${esc(r.room_number)}</span>
              <span class="grow"><span class="bold">${r.incidents} incidencias</span>
                <div class="tiny muted">Piso ${r.floor_number} · última ${esc(r.last_at ?? '')}</div></span>
              <span class="chip warn tiny">${icon('repeat', 11)}${r.incidents}</span>
            </button>`).join('')}</div>` : emptyState('Ninguna habitación reincidente en el periodo.', 'check-circle')}
          </div></section>

        <section class="card"><div class="card-head"><h2>Tendencia (14 días)</h2></div>
          <div class="card-body">
            ${d.trend.map((t) => `<div class="row" style="gap:9px;margin-bottom:5px">
              <span class="tiny muted mono" style="width:52px">${esc(t.fecha.slice(5))}</span>
              <span class="bar grow">
                <span style="width:${((t.movimientos - (t.incidencias ?? 0)) / maxTrend) * 100}%;background:var(--plum-500)"></span>
                <span style="width:${((t.incidencias ?? 0) / maxTrend) * 100}%;background:var(--danger)"></span>
              </span>
              <span class="tiny mono" style="width:34px;text-align:right">${t.movimientos}</span>
            </div>`).join('')}
            <div class="row tiny muted" style="gap:14px;margin-top:8px">
              <span class="row" style="gap:5px"><span style="width:9px;height:9px;border-radius:2px;background:var(--plum-500)"></span>Movimientos</span>
              <span class="row" style="gap:5px"><span style="width:9px;height:9px;border-radius:2px;background:var(--danger)"></span>Incidencias</span>
            </div>
          </div></section>

        <section class="card"><div class="card-head"><h2>Acciones más registradas</h2></div>
          <div class="card-body flush">${d.topActions.length ? `<div class="table-scroll"><table>
            <thead><tr><th>Acción</th><th>Total</th><th>Incidencias</th></tr></thead>
            <tbody>${d.topActions.map((a) => `<tr><td>${esc(a.action)}</td>
              <td class="mono">${a.total}</td><td class="mono">${a.incidencias ?? 0}</td></tr>`).join('')}</tbody>
            </table></div>` : emptyState('Sin datos en el periodo.')}</div></section>

        <section class="card"><div class="card-head"><h2>Usuarios más activos</h2></div>
          <div class="card-body flush">${d.topUsers.length ? `<div class="table-scroll"><table>
            <thead><tr><th>Usuario</th><th>Departamento</th><th>Movimientos</th></tr></thead>
            <tbody>${d.topUsers.map((u) => `<tr><td>${esc(u.user_name)}</td>
              <td>${esc(u.department_name ?? '—')}</td><td class="mono">${u.movimientos}</td></tr>`).join('')}</tbody>
            </table></div>` : emptyState('Sin datos en el periodo.')}</div></section>
      </div>`;
  };

  await load('mes');
  $('[data-period]', outlet).addEventListener('change', (e) => load(e.target.value));
  outlet.addEventListener('click', (e) => {
    const f = e.target.closest('[data-floor-go]');
    if (f) location.hash = `#/pisos/${f.dataset.floorGo}`;
  });
  bindRooms(outlet, () => load($('[data-period]', outlet).value));
}

// ================================================================ Reportes
export async function reportsView(outlet) {
  const filters = { period: 'mes', from: '', to: '', floorId: '', roomNumber: '', departmentId: '',
    userId: '', categoryId: '', statusCode: '', incidentsOnly: '' };

  outlet.innerHTML = `
    <div class="page-head">
      <div><h1>Reportes</h1><p>Diarios, semanales y mensuales con filtros y exportación.</p></div>
      ${can('report.export') ? `<div class="row wrap">
        <button class="btn" data-export="csv">${icon('download', 15)} CSV</button>
        <button class="btn" data-export="xlsx">${icon('download', 15)} Excel</button>
        <button class="btn primary" data-export="pdf">${icon('download', 15)} PDF</button>
      </div>` : ''}
    </div>

    <div class="card" style="margin-bottom:14px"><div class="card-body">
      <div class="grid-2">
        <div class="field"><label>Periodo</label><select data-f="period">
          <option value="hoy">Diario (hoy)</option><option value="semana">Semanal (7 días)</option>
          <option value="mes" selected>Mensual (30 días)</option><option value="trimestre">90 días</option>
          <option value="anio">Último año</option><option value="todo">Todo el historial</option>
        </select></div>
        <div class="field"><label>Desde (personalizado)</label><input type="date" data-f="from"></div>
        <div class="field"><label>Hasta (personalizado)</label><input type="date" data-f="to"></div>
        <div class="field"><label>Piso</label><select data-f="floorId"><option value="">Todos</option>
          ${state.floors.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Habitación</label><input type="text" data-f="roomNumber" placeholder="Ej. 618" inputmode="numeric"></div>
        <div class="field"><label>Departamento</label><select data-f="departmentId"><option value="">Todos</option>
          ${state.departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Usuario</label><select data-f="userId"><option value="">Todos</option>
          ${state.users.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}</select></div>
        <div class="field"><label>Categoría</label><select data-f="categoryId"><option value="">Todas</option>
          ${state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Estado</label><select data-f="statusCode"><option value="">Todos</option>
          ${state.statuses.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Sólo incidencias</label><select data-f="incidentsOnly">
          <option value="">No</option><option value="true">Sí</option></select></div>
      </div>
    </div></div>

    <div data-summary style="margin-bottom:14px"></div>
    <div class="card"><div class="card-head"><h2>Movimientos</h2><span class="tiny muted" data-count></span></div>
      <div class="card-body flush"><div class="table-scroll" data-table>${spinner()}</div></div></div>`;

  const load = async () => {
    const [rep, sum] = await Promise.all([
      api.get('api/reports/movements', { ...filters, limit: 300 }),
      api.get('api/reports/summary', filters),
    ]);
    $('[data-count]', outlet).textContent =
      `${rep.total} movimientos · ${rep.incidents} incidencias · ${fmtDate(rep.range.from)} a ${fmtDate(rep.range.to)}`;
    $('[data-summary]', outlet).innerHTML = `<div class="kpis" style="margin:0">
      ${[['Movimientos', rep.total, 'var(--plum-500)'], ['Incidencias', rep.incidents, 'var(--danger)'],
         ['Días con actividad', sum.byDay.length, 'var(--info)'],
         ['Reincidentes', sum.recurrence.rooms.length, 'var(--warn)']]
        .map(([l, v, c]) => `<div class="kpi" style="--accent:${c}"><div class="n">${v}</div><div class="l">${l}</div></div>`).join('')}
    </div>`;
    $('[data-table]', outlet).innerHTML = rep.items.length ? `<table>
      <thead><tr><th>Fecha</th><th>Hora</th><th>Hab.</th><th>Depto.</th><th>Usuario</th>
        <th>Acción</th><th>Campo</th><th>Antes</th><th>Después</th><th>Comentario</th></tr></thead>
      <tbody>${rep.items.map((m) => `<tr ${m.is_incident ? 'style="background:var(--danger-bg)"' : ''}>
        <td class="mono">${fmtDate(m.local_date)}</td><td class="mono">${esc((m.local_time ?? '').slice(0, 5))}</td>
        <td><button class="btn sm ghost" data-room="${m.room_id}" style="padding:0;min-height:auto"><strong>${esc(m.room_number)}</strong></button></td>
        <td>${esc(m.department_name ?? '—')}</td><td>${esc(m.user_name)}</td>
        <td>${esc(m.action)}</td><td>${esc(m.field_label ?? '—')}</td>
        <td class="muted">${esc(m.old_value ?? '—')}</td><td class="bold">${esc(m.new_value ?? '—')}</td>
        <td style="max-width:280px">${esc(m.comment ?? '')}</td></tr>`).join('')}</tbody></table>`
      : emptyState('Sin movimientos para los filtros seleccionados.', 'inbox');
  };

  outlet.addEventListener('change', (e) => {
    if (!e.target.dataset.f) return;
    filters[e.target.dataset.f] = e.target.value;
    if (e.target.dataset.f === 'from' || e.target.dataset.f === 'to') filters.period = '';
    load();
  });
  outlet.addEventListener('input', (e) => { if (e.target.dataset.f === 'roomNumber') { filters.roomNumber = e.target.value; } });
  outlet.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-export]');
    if (!b) return;
    const fmt = b.dataset.export;
    const original = b.innerHTML;
    b.disabled = true; b.innerHTML = '<span class="spinner dark"></span>';
    try {
      const name = await download('api/reports/export', { ...filters, format: fmt }, `CDH_reporte.${fmt}`);
      toast(`Reporte descargado: ${name}`);
    } catch (err) { toast(err.message, 'error'); }
    b.disabled = false; b.innerHTML = original;
  });
  await load();
  bindRooms(outlet, load);
}

// ================================================================ Auditoría
export async function auditView(outlet) {
  const filters = { entityType: '', action: '', userId: '', from: '', to: '' };
  let offset = 0;

  outlet.innerHTML = `
    <div class="page-head"><div><h1>Bitácora de auditoría</h1>
      <p>Qué cambió, quién, cuándo, dónde, qué había antes, qué quedó después y por qué. Registro inmutable.</p></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-body"><div class="grid-2" data-filters></div></div></div>
    <div class="card"><div class="card-head"><h2>Registros</h2><span class="tiny muted" data-count></span></div>
      <div class="card-body flush"><div class="table-scroll" data-table>${spinner()}</div></div>
      <div class="card-body center" data-more hidden><button class="btn" data-load-more>Cargar más</button></div>
    </div>`;

  const first = await api.get('api/audit', { limit: 60 });
  $('[data-filters]', outlet).innerHTML = `
    <div class="field"><label>Entidad</label><select data-f="entityType"><option value="">Todas</option>
      ${first.entityTypes.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></div>
    <div class="field"><label>Acción</label><select data-f="action"><option value="">Todas</option>
      ${first.actions.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}</select></div>
    <div class="field"><label>Usuario</label><select data-f="userId"><option value="">Todos</option>
      ${state.users.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}</select></div>
    <div class="field"><label>Desde</label><input type="date" data-f="from"></div>
    <div class="field"><label>Hasta</label><input type="date" data-f="to"></div>`;

  const fmtJson = (raw) => {
    if (!raw) return '<span class="muted">—</span>';
    try {
      return Object.entries(JSON.parse(raw))
        .map(([k, v]) => `<div class="tiny"><span class="muted">${esc(k)}:</span> ${esc(
          typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—'))}</div>`).join('');
    } catch { return esc(raw); }
  };

  const rows = (items) => items.map((a) => `<tr>
      <td class="mono tiny" style="white-space:nowrap">${fmtDate(a.local_date)}<br>${esc((a.local_time ?? '').slice(0, 8))}</td>
      <td><span class="chip tiny">${esc(a.action)}</span></td>
      <td><div class="bold tiny">${esc(a.entity_type)}</div><div class="tiny muted">${esc(a.entity_label ?? a.entity_id ?? '')}</div></td>
      <td><div class="tiny">${esc(a.actor_name ?? 'sistema')}</div>
          <div class="tiny muted">${esc(a.actor_role ?? '')}</div></td>
      <td style="max-width:220px">${fmtJson(a.before_json)}</td>
      <td style="max-width:220px">${fmtJson(a.after_json)}</td>
      <td class="tiny" style="max-width:230px">${esc(a.reason ?? '')}</td>
    </tr>`).join('');

  const table = $('[data-table]', outlet);
  const load = async (append = false) => {
    if (!append) { offset = 0; table.innerHTML = spinner(); }
    const data = await api.get('api/audit', { ...filters, limit: 60, offset });
    const html = rows(data.items);
    if (append) $('tbody', table)?.insertAdjacentHTML('beforeend', html);
    else {
      table.innerHTML = data.items.length ? `<table>
        <thead><tr><th>Fecha</th><th>Acción</th><th>Entidad</th><th>Usuario</th><th>Antes</th><th>Después</th><th>Motivo</th></tr></thead>
        <tbody>${html}</tbody></table>` : emptyState('Sin registros para los filtros seleccionados.', 'shield');
    }
    $('[data-count]', outlet).textContent = `${data.total} registros`;
    offset += data.items.length;
    $('[data-more]', outlet).hidden = offset >= data.total;
  };

  outlet.addEventListener('change', (e) => { if (e.target.dataset.f) { filters[e.target.dataset.f] = e.target.value; load(); } });
  $('[data-load-more]', outlet).addEventListener('click', () => load(true));
  await load();
}
