import { api } from '../api.js';
import { icon } from '../icons.js';
import {
  $, $$, el, esc, drawer, modal, toast, spinner, emptyState, statusChip,
  relative, fmtDate, lightbox,
} from '../ui.js';
import { state, can } from '../store.js';

let quickActionsCache = null;
async function quickActions() {
  if (!quickActionsCache) quickActionsCache = await api.get('api/rooms/meta/quick-actions');
  return quickActionsCache;
}
export const resetQuickActions = () => { quickActionsCache = null; };

/** Abre el expediente de una habitación. */
// Sólo puede haber un expediente abierto a la vez: si algún origen dispara
// dos veces, la segunda apertura se descarta en vez de apilar paneles.
let openRoomDrawer = null;

export async function openRoom(roomId, { onChange = null, tab = 'detalle' } = {}) {
  if (openRoomDrawer) return openRoomDrawer;

  let dirty = false;
  const d = drawer({
    title: 'Habitación', subtitle: 'Cargando expediente…', body: spinner(),
    onClose: () => { openRoomDrawer = null; },
  });
  // Se registra ANTES de cualquier await: dos clics en el mismo tick deben
  // encontrar el guardián ya puesto.
  openRoomDrawer = { close: d.close, get dirty() { return dirty; } };

  const load = async (activeTab = tab) => {
    const data = await api.get(`api/rooms/${roomId}`);
    const r = data.room;
    $('h2', d.panel).innerHTML = `Habitación ${esc(r.number)}`;
    $('.drawer-head p', d.panel).innerHTML =
      `${esc(r.floor_name)} · ${esc(r.type_name ?? 'Sin tipo asignado')}${r.active ? '' : ' · <strong>Desactivada</strong>'}`;
    d.body.innerHTML = '';
    d.body.appendChild(renderRoom(data, activeTab));
  };

  const renderRoom = (data, activeTab) => {
    const r = data.room;
    const node = el(`<div>
      <section class="card" style="margin-bottom:14px">
        <div class="card-body">
          <div class="row-between wrap" style="margin-bottom:10px">
            <div class="row wrap" style="gap:8px">
              ${statusChip({ name: r.status_name, icon: r.status_icon, color: r.status_color }, 14)}
              ${r.incidentCount ? `<span class="chip danger">${icon('alert', 13)}${r.incidentCount} incidencia${r.incidentCount > 1 ? 's' : ''} abierta${r.incidentCount > 1 ? 's' : ''}</span>` : ''}
              ${data.recurrence.incidents >= (data.recurrence.thresholds[0] ?? 2)
                ? `<span class="chip warn">${icon('repeat', 13)}Reincidente · ${data.recurrence.incidents} en ${data.recurrence.window} d</span>` : ''}
            </div>
            <span class="tiny muted">${data.movementCount} movimiento${data.movementCount === 1 ? '' : 's'}</span>
          </div>
          ${data.cleaningRequest ? `<div class="hint-block" style="margin:0 0 10px;border-color:${
            esc(data.cleaningRequest.priority_color)}66;background:${esc(data.cleaningRequest.priority_color)}12">
            ${icon('spray', 14)}<span><strong>Limpieza solicitada · ${esc(data.cleaningRequest.priority_name)}.</strong>
            La pidió ${esc(data.cleaningRequest.requested_by_name)} ${relative(data.cleaningRequest.requested_at)}${
              data.cleaningRequest.note ? ` — ${esc(data.cleaningRequest.note)}` : ''}.
            Se cierra sola al registrar la limpieza.</span></div>` : ''}
          <div class="row wrap small muted" style="gap:14px;margin-top:10px">
            <span>${icon('clock', 13)} Última actualización: <strong class="bold" style="color:var(--ink-2)">${
              r.updated_at ? relative(r.updated_at) : 'sin registro'}</strong></span>
            ${r.updated_by_name ? `<span>${icon('user', 13)} ${esc(r.updated_by_name)}</span>` : ''}
          </div>
        </div>
      </section>

      <div class="tabs" role="tablist">
        <button role="tab" data-tab="detalle" aria-selected="${activeTab === 'detalle'}">Detalle</button>
        <button role="tab" data-tab="accion"  aria-selected="${activeTab === 'accion'}">Registrar</button>
        ${can('history.view') ? `<button role="tab" data-tab="historial" aria-selected="${activeTab === 'historial'}">Historial</button>` : ''}
      </div>
      <div data-panel></div>
    </div>`);

    const panel = $('[data-panel]', node);
    const show = (t) => {
      $$('[data-tab]', node).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
      panel.innerHTML = spinner();
      if (t === 'detalle')   panel.replaceChildren(detailPanel(data, reload));
      if (t === 'accion')    actionPanel(panel, data, reload);
      if (t === 'historial') historyPanel(panel, r);
    };
    $$('[data-tab]', node).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    show(activeTab);
    return node;
  };

  const reload = async (activeTab = 'detalle') => {
    dirty = true;
    await load(activeTab);
    onChange?.();
  };

  await load(tab);
  return openRoomDrawer;
}

// ------------------------------------------------------------------ Detalle
function detailPanel(data, reload) {
  const node = el('<div></div>');
  if (!data.categories.length) { node.innerHTML = emptyState('No hay categorías configuradas.'); return node; }

  // Un reporte abierto no se ve en ningún campo: sin esta lista, el
  // expediente diría "1 incidencia abierta" sin decir cuál.
  if (data.openIncidents.length) {
    const bloquean = data.openIncidents.filter((i) => i.blocksRelease).length;
    node.appendChild(el(`
      <div class="open-incidents">
        <div class="tiny bold" style="text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">
          ${icon('alert', 13)} ${data.openIncidents.length === 1
            ? 'Incidencia abierta' : `${data.openIncidents.length} incidencias abiertas`}
        </div>
        ${data.openIncidents.map((i) => `<div class="oi">
          <span class="chip tiny">${esc(i.category ?? 'General')}</span>
          <span><strong>${esc(i.field)}</strong>${i.value ? ` — ${esc(i.value)}` : ''}</span>
          ${i.blocksRelease ? `<span class="chip danger tiny">${icon('lock', 10)}Impide liberar</span>` : ''}
        </div>`).join('')}
        ${bloquean ? `<div class="tiny" style="margin-top:7px;opacity:.9">
          ${icon('lock', 12)} Mientras siga abierta, la habitación no puede quedar disponible ni darse
          por inspeccionada. Ciérrela desde el área responsable.</div>` : ''}
      </div>`));
  }

  for (const cat of data.categories) {
    const incidents = cat.fields.filter((f) => f.isIncident).length;
    const box = el(`
      <details class="detail-cat" ${incidents || cat.code === 'AMA' ? 'open' : ''}>
        <summary>
          <span style="color:${esc(cat.color)}">${icon(cat.icon, 17)}</span>
          <span>${esc(cat.name)}</span>
          ${incidents ? `<span class="chip danger tiny">${incidents}</span>` : ''}
          ${cat.canEdit ? '' : '<span class="chip tiny">Sólo lectura</span>'}
          <span class="caret">${icon('chevron', 15)}</span>
        </summary>
        <div class="detail-fields"></div>
      </details>`);

    const list = $('.detail-fields', box);
    for (const f of cat.fields) {
      const row = el(`
        <div class="dfield ${f.isIncident ? 'is-incident' : ''}">
          <div class="dlabel">${esc(f.label)}</div>
          <div class="grow">
            <div class="dvalue ${f.value ? '' : 'empty-val'}">
              ${f.isIncident ? icon('alert', 13, 'style="display:inline;vertical-align:-2px"') : ''}
              ${esc(f.value || 'Sin registro')}
            </div>
            ${f.updatedAt ? `<div class="dmeta">${relative(f.updatedAt)}${f.updatedBy ? ` · ${esc(f.updatedBy)}` : ''}</div>` : ''}
          </div>
          ${cat.canEdit ? `<button class="btn sm ghost" data-edit="${f.code}" aria-label="Editar ${esc(f.label)}">${icon('edit', 14)}</button>` : ''}
        </div>`);
      list.appendChild(row);
    }

    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-edit]');
      if (!btn) return;
      e.preventDefault();
      const field = cat.fields.find((f) => f.code === btn.dataset.edit);
      editField(data.room, cat, field, reload);
    });
    node.appendChild(box);
  }
  return node;
}

/** Edita un campo: el comentario explica el POR QUÉ del cambio. */
function editField(room, cat, field, reload) {
  const input = field.type === 'select'
    ? `<select name="value">
         <option value="">— Sin registro —</option>
         ${field.options.map((o) => `<option ${o === field.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}
       </select>`
    : field.type === 'textarea'
      ? `<textarea name="value" rows="3">${esc(field.value ?? '')}</textarea>`
      : `<input type="${field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}"
                name="value" value="${esc(field.value ?? '')}">`;

  // Si el área retira habitaciones de la venta, conviene decirlo ANTES de
  // guardar: quien marca la falla debe saber que la habitación deja de estar
  // disponible en el mismo movimiento.
  const aviso = cat.blocksRelease && room.counts_ready && field.incidentValues?.length
    // El texto va dentro de un solo <span>: en un contenedor flex, cada
    // <strong> suelto se convertiría en una columna aparte.
    ? `<div class="hint-block">${icon('lock', 13)}<span>Registrar ${
        field.incidentValues.map((v) => `<strong>${esc(v)}</strong>`).join(', ')
      } retira la habitación de la venta${
        cat.pendingStatus ? `: pasará a <strong>${esc(cat.pendingStatus)}</strong>` : ''}.</span></div>`
    : '';

  const m = modal({
    title: `${esc(cat.name)} — ${esc(field.label)}`,
    body: `<form id="fieldForm">
        ${aviso}
        <div class="field">
          <label>Valor nuevo</label>
          ${input}
          ${field.incidentValues.length
            ? `<span class="hint">${icon('alert', 11, 'style="display:inline;vertical-align:-1px"')} Abre incidencia: ${field.incidentValues.map(esc).join(', ')}</span>` : ''}
        </div>
        <div class="field">
          <label>Comentario</label>
          <textarea name="comment" rows="2" placeholder="¿Por qué cambia? (opcional pero recomendado)"></textarea>
        </div>
        <div class="readonly-note">${icon('shield', 14)}
          <span>Habitación ${esc(room.number)} · Valor anterior: <strong>${esc(field.value || 'Sin registro')}</strong>.
          Fecha, hora, usuario y departamento los registra el servidor automáticamente.</span>
        </div>
      </form>`,
    footer: `<button class="btn" data-close>Cancelar</button>
             <button class="btn primary" form="fieldForm" type="submit">Guardar movimiento</button>`,
  });

  $('#fieldForm', m.wrap).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('[type=submit]', m.footer);
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Guardando…';
    const fd = new FormData(e.target);
    try {
      await api.post(`api/rooms/${room.id}/movements`, {
        details: [{ fieldCode: field.code, value: fd.get('value') }],
        comment: fd.get('comment') || null,
      });
      m.close();
      toast(`${field.label} actualizado en la habitación ${room.number}.`);
      await reload('detalle');
    } catch (err) {
      toast(err.message, 'error', 5200);
      btn.disabled = false; btn.textContent = 'Guardar movimiento';
    }
  });
}

// ------------------------------------------------ Registrar (acción rápida)
async function actionPanel(panel, data, reload) {
  const room = data.room;
  if (!data.canCreateMovement) {
    panel.innerHTML = emptyState('Su rol no tiene permiso para registrar movimientos.', 'lock');
    return;
  }
  const { actions, groups } = await quickActions();
  panel.innerHTML = '';
  const porCodigo = (code) => actions.find((a) => a.code === code);
  const abrir = (code) => actionForm(room, porCodigo(code), reload, data.pmsNotice);

  const grid = el(`<div class="card"><div class="card-head"><h2>Acciones rápidas</h2></div>
    <div class="card-body"></div></div>`);
  const cuerpo = $('.card-body', grid);

  for (const g of groups) {
    const seccion = el(`<section class="grupo">
      <h3>${icon(g.icon, 14)}${esc(g.name)}</h3>
      <div class="quick"></div>
    </section>`);
    const q = $('.quick', seccion);

    // Un grupo de entrada única —los reportes— es UNA tarjeta: el área se
    // elige después, dentro del propio gesto de reportar.
    if (g.oneEntry) {
      q.appendChild(el(`<button class="entrada" data-group="${esc(g.code)}">
        <span style="color:var(--plum-600)">${icon(g.icon, 19)}</span>
        <span class="qn">${esc(g.entryName)}</span>
        <span class="qs">${esc(g.entryHint ?? '')}</span>
      </button>`));
    } else {
      for (const code of g.actions) {
        const a = porCodigo(code);
        q.appendChild(el(`<button data-action="${esc(a.code)}" data-severity="${esc(a.severity)}">
          <span style="color:var(--plum-600)">${icon(a.icon, 19)}</span>
          <span class="qn">${esc(a.name)}</span>
          <span class="qs">${a.target_from_clean ? '→ según el estado actual'
            : a.target_status_name ? `→ ${esc(a.target_status_name)}` : 'Sin cambio de estado'}</span>
        </button>`));
      }
    }
    cuerpo.appendChild(seccion);
  }

  cuerpo.addEventListener('click', (e) => {
    const accion = e.target.closest('[data-action]');
    if (accion) return abrir(accion.dataset.action);
    const grupo = e.target.closest('[data-group]');
    if (grupo) elegirArea(groups.find((g) => g.code === grupo.dataset.group), actions, abrir);
  });
  panel.appendChild(grid);

  if (data.canRequestCleaning && data.cleaningPriorities.length) {
    const sol = el(`<div class="card" style="margin-top:14px">
      <div class="card-head"><h2>${data.cleaningRequest ? 'Subir la prioridad de la limpieza' : 'Solicitar limpieza'}</h2></div>
      <div class="card-body">
        <form id="solicitudForm">
          <div class="field"><label>Prioridad</label>
            <select name="priority">${data.cleaningPriorities.map((p) =>
              `<option value="${esc(p.code)}">${esc(p.name)} — ${esc(p.description ?? '')}</option>`).join('')}</select>
            ${data.cleaningRequest ? `<span class="hint">Ya hay una solicitud en <strong>${
              esc(data.cleaningRequest.priority_name)}</strong>: sólo cambia si elige una mayor.</span>` : ''}
          </div>
          <div class="field"><label>Nota para Ama de Llaves</label>
            <textarea name="note" rows="2" placeholder="Qué hay que hacer y por qué corre prisa."></textarea></div>
          <button class="btn primary block" type="submit">
            ${data.cleaningRequest ? 'Actualizar la solicitud' : 'Solicitar limpieza'}</button>
        </form>
      </div></div>`);
    $('#solicitudForm', sol).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = $('[type=submit]', e.target);
      const etiqueta = btn.textContent.trim();
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Guardando…';
      try {
        const r = await api.post('api/cleaning/requests', {
          roomId: room.id, priority: fd.get('priority'), note: fd.get('note') || null,
        });
        toast(r.creadas.length ? `Limpieza solicitada para la habitación ${room.number}.`
          : r.elevadas.length ? 'Prioridad elevada.'
            : 'La solicitud ya estaba en una prioridad igual o mayor.', r.sinCambio.length ? 'warn' : 'ok');
        await reload('detalle');
      } catch (err) {
        toast(err.message, 'error', 5200);
        btn.disabled = false; btn.textContent = etiqueta;
      }
    });
    panel.appendChild(sol);
  }

  if (data.canEditStatus) {
    const sc = el(`<div class="card" style="margin-top:14px">
      <div class="card-head"><h2>Cambiar estado manualmente</h2></div>
      <div class="card-body">
        <form id="statusForm">
          <div class="field"><label>Estado nuevo</label>
            <select name="status">${state.statuses.map((s) =>
              `<option value="${esc(s.code)}" ${s.code === room.status_code ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label>Comentario</label>
            <textarea name="comment" rows="2" placeholder="Motivo del cambio de estado"></textarea></div>
          ${data.pmsNotice ? `<div class="pms-notice">${icon('alert', 15)}<span>${esc(data.pmsNotice)}</span></div>` : ''}
          <button class="btn primary block" type="submit">Registrar cambio de estado</button>
        </form>
      </div></div>`);
    $('#statusForm', sc).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (fd.get('status') === room.status_code) return toast('La habitación ya está en ese estado.', 'warn');
      const btn = $('[type=submit]', e.target);
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Guardando…';
      try {
        await api.post(`api/rooms/${room.id}/movements`, { status: fd.get('status'), comment: fd.get('comment') || null });
        toast(`Estado actualizado en la habitación ${room.number}.`);
        await reload('detalle');
      } catch (err) {
        toast(err.message, 'error', 5200);
        btn.disabled = false; btn.textContent = 'Registrar cambio de estado';
      }
      return undefined;
    });
    panel.appendChild(sc);
  }
}

/** Formulario de acción: el usuario sólo elige detalle, comentario y fotos. */
/**
 * Paso previo de un grupo de entrada única: a quién va el reporte.
 *
 * Las áreas salen de la categoría de cada acción, no de una lista escrita
 * aquí: si mañana se añade un área desde Administración, aparece sola. Y sólo
 * se ofrecen las acciones que el usuario puede registrar, que son las que el
 * servidor mandó.
 */
function elegirArea(grupo, actions, abrir) {
  const suyas = grupo.actions.map((code) => actions.find((a) => a.code === code));
  const areas = [];
  for (const a of suyas) {
    const nombre = a.category_name ?? 'Sin área';
    const area = areas.find((x) => x.nombre === nombre) ?? (areas.push({ nombre, acciones: [] }), areas.at(-1));
    area.acciones.push(a);
  }

  const m = modal({
    title: grupo.pickTitle ?? grupo.name,
    body: `<div class="areas">${areas.map((area) => `
      <div class="area">
        <h4>${esc(area.nombre)}</h4>
        <div class="quick">${area.acciones.map((a) => `
          <button data-action="${esc(a.code)}" data-severity="${esc(a.severity)}">
            <span style="color:var(--plum-600)">${icon(a.icon, 19)}</span>
            <span class="qn">${esc(a.name)}</span>
            <span class="qs">${a.target_status_name ? `→ ${esc(a.target_status_name)}` : 'Sin cambio de estado'}</span>
          </button>`).join('')}</div>
      </div>`).join('')}</div>
      <div class="readonly-note" style="margin-top:12px">${icon('user', 14)}
        <span>Se le preguntará si el huésped estará en la habitación: es lo que el área
        necesita saber antes de subir.</span>
      </div>`,
    footer: '<button class="btn" data-close>Cancelar</button>',
  });

  $('.areas', m.wrap).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    m.close();
    abrir(btn.dataset.action);
  });
}

function actionForm(room, action, reload, avisoPms = null) {
  const allowPhotos = action.allows_photo && can('photo.upload');
  const m = modal({
    title: action.name,
    body: `<form id="actionForm">
      <div class="row wrap" style="gap:8px;margin-bottom:14px">
        <span class="chip plum">${icon('door', 13)}Habitación ${esc(room.number)}</span>
        ${action.category_name ? `<span class="chip">${esc(action.category_name)}</span>` : ''}
        ${action.target_status_name ? `<span class="chip info">${icon('swap', 13)}→ ${esc(action.target_status_name)}</span>` : ''}
        ${action.is_incident ? `<span class="chip danger">${icon('alert', 13)}Abre incidencia</span>` : ''}
      </div>
      ${action.warnsPms && avisoPms ? `<div class="pms-notice">${icon('alert', 15)}<span>${esc(avisoPms)}</span></div>` : ''}
      ${action.asksGuestPresent ? `
      <div class="field">
        <label>¿El huésped estará en la habitación? <span style="color:var(--danger)">*</span></label>
        <div class="opciones">
          <label><input type="radio" name="guestPresent" value="si" required><span>Sí, estará</span></label>
          <label><input type="radio" name="guestPresent" value="no"><span>No, está libre</span></label>
          <label><input type="radio" name="guestPresent" value="desconocido"><span>No se sabe</span></label>
        </div>
        <span class="hint">${icon('user', 11, 'style="display:inline;vertical-align:-1px"')} Viaja con el
        reporte: es lo que ${esc(action.category_name ?? 'el área responsable')} necesita saber antes de subir.</span>
      </div>` : ''}
      <div class="field">
        <label>Comentario ${action.requiresComment ? '<span style="color:var(--danger)">*</span>' : ''}</label>
        <textarea name="comment" rows="3" ${action.requiresComment ? 'required' : ''}
          placeholder="Describa el detalle: qué observó y por qué registra esta acción."></textarea>
      </div>
      ${allowPhotos ? `
      <div class="field">
        <label>Fotografías ${action.requiresPhoto ? '<span style="color:var(--danger)">*</span>' : ''}</label>
        <input type="file" name="photos" accept="image/*" capture="environment" multiple
               ${action.requiresPhoto ? 'required' : ''}>
        <span class="hint">Hasta 8 imágenes. Se asocian a la habitación, al movimiento, al usuario y a la hora del servidor.</span>
      </div>
      <div class="field">
        <label>Tipo de fotografía</label>
        <select name="photoKind">
          <option value="general">General</option>
          <option value="antes">Foto antes</option>
          <option value="despues">Foto después</option>
        </select>
      </div>` : ''}
      <div class="readonly-note">${icon('shield', 14)}
        <span>Fecha, hora, usuario, departamento y sello de tiempo son automáticos y no editables.</span>
      </div>
    </form>`,
    footer: `<button class="btn" data-close>Cancelar</button>
             <button class="btn primary" form="actionForm" type="submit">Guardar</button>`,
  });

  $('#actionForm', m.wrap).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('[type=submit]', m.footer);
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Guardando…';
    const form = e.target;
    const body = new FormData();
    body.append('movementType', action.code);
    body.append('comment', form.comment.value ?? '');
    if (action.asksGuestPresent) body.append('guestPresent', form.guestPresent?.value ?? '');
    const files = form.photos?.files ?? [];
    const kinds = {};
    [...files].forEach((f, i) => { body.append('photos', f); kinds[String(i)] = form.photoKind?.value ?? 'general'; });
    if (files.length) body.append('photoKinds', JSON.stringify(kinds));

    try {
      const res = await fetch(`api/rooms/${room.id}/movements`, { method: 'POST', body, credentials: 'same-origin' });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? 'No fue posible guardar.');
      m.close();
      toast(`${action.name} · habitación ${room.number}.`);
      await reload('detalle');
    } catch (err) {
      toast(err.message, 'error', 5200);
      btn.disabled = false; btn.textContent = 'Guardar';
    }
  });
}

// ---------------------------------------------------------------- Historial
async function historyPanel(panel, room) {
  const filters = { from: '', to: '', departmentId: '', userId: '', categoryId: '', incidentsOnly: '' };

  const bar = el(`<div class="card" style="margin-bottom:12px"><div class="card-body" style="padding:12px">
    <div class="grid-2">
      <div class="field"><label>Desde</label><input type="date" data-f="from"></div>
      <div class="field"><label>Hasta</label><input type="date" data-f="to"></div>
      <div class="field"><label>Departamento</label><select data-f="departmentId"><option value="">Todos</option>
        ${state.departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Categoría</label><select data-f="categoryId"><option value="">Todas</option>
        ${state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Usuario</label><select data-f="userId"><option value="">Todos</option>
        ${state.users.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}</select></div>
      <div class="field"><label>Sólo incidencias</label><select data-f="incidentsOnly">
        <option value="">No</option><option value="true">Sí</option></select></div>
    </div>
  </div></div>`);

  const listBox = el('<div></div>');
  panel.replaceChildren(bar, listBox);

  const load = async () => {
    listBox.innerHTML = spinner();
    const data = await api.get(`api/rooms/${room.id}/history`, { ...filters, limit: 100 });
    if (!data.items.length) { listBox.innerHTML = emptyState('Sin movimientos para los filtros seleccionados.', 'history'); return; }
    listBox.innerHTML = `<p class="small muted" style="margin:0 0 10px">${data.total} movimiento${data.total === 1 ? '' : 's'}</p>
      <div class="timeline">${data.items.map(timelineItem).join('')}</div>`;
    $$('img[data-full]', listBox).forEach((img) =>
      img.addEventListener('click', () => lightbox(img.dataset.full, img.alt)));
  };

  bar.addEventListener('change', (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    filters[f] = e.target.value;
    load();
  });
  load();
}

export function timelineItem(m) {
  const changed = m.field_label && (m.old_value !== null || m.new_value !== null);
  // Lo que el reporte dijo del huésped: quien lo lee después necesita saber
  // con qué se encontró —o esperaba encontrarse— el área que subió.
  const huesped = { si: 'El huésped estaría en la habitación', no: 'La habitación estaría libre',
    desconocido: 'No se sabía si el huésped estaría' }[m.guest_present] ?? null;
  return `<div class="tl-item ${m.is_incident ? 'incident' : ''} ${m.action_code === 'STATUS_CHANGE' || m.new_status_name !== m.old_status_name ? 'status' : ''}">
    <div class="tl-card">
      <div class="row-between wrap" style="gap:6px">
        <strong style="font-size:13.5px">${esc(m.action)}</strong>
        <span class="tiny muted mono">${fmtDate(m.local_date)} · ${esc((m.local_time ?? '').slice(0, 5))}</span>
      </div>
      <div class="row wrap tiny muted" style="gap:10px;margin-top:3px">
        <span>${icon('user', 11)} ${esc(m.user_name)}</span>
        ${m.department_name ? `<span>${icon('users', 11)} ${esc(m.department_name)}</span>` : ''}
        ${m.category_name ? `<span>${icon('folder', 11)} ${esc(m.category_name)}</span>` : ''}
        ${m.is_incident ? `<span style="color:var(--danger);font-weight:650">${icon('alert', 11)} Incidencia${m.severity !== 'normal' ? ` ${esc(m.severity)}` : ''}</span>` : ''}
      </div>
      ${changed ? `<div class="change"><span class="tiny muted">${esc(m.field_label)}:</span>
        <span class="val before">${esc(m.old_value || 'Sin registro')}</span>
        ${icon('chevron', 12)}<span class="val after">${esc(m.new_value || 'Sin registro')}</span></div>` : ''}
      ${huesped ? `<div class="tiny" style="margin-top:5px;color:var(--ink-2)">
        ${icon('user', 11, 'style="display:inline;vertical-align:-1px"')} ${esc(huesped)}</div>` : ''}
      ${m.comment ? `<div class="tl-comment">${esc(m.comment)}</div>` : ''}
      ${(m.photos ?? []).length ? `<div class="photos">${m.photos.map((p) => `
        <figure><img src="${esc(p.url)}" data-full="${esc(p.url)}" alt="Foto ${esc(p.kind)} habitación ${esc(m.room_number)}" loading="lazy">
        <figcaption>${p.kind === 'antes' ? 'Antes' : p.kind === 'despues' ? 'Después' : 'Foto'}</figcaption></figure>`).join('')}</div>` : ''}
    </div>
  </div>`;
}
