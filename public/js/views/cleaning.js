// ============================================================================
// Centro de solicitudes de limpieza.
//
// Dos mitades con públicos distintos: la COLA, que es lo que Ama de Llaves
// tiene por hacer, ordenada por prioridad y por lo que lleva esperando; y las
// habitaciones LIMPIAS, que es de donde Recepción toma para entregar.
// ============================================================================
import { api } from '../api.js';
import { icon } from '../icons.js';
import { $, esc, modal, toast, spinner, emptyState, relative } from '../ui.js';
import { state } from '../store.js';
import { openRoom } from './room.js';

/** Cuánto lleva esperando, dicho como lo diría una persona. */
function espera(desde) {
  const min = Math.max(0, Math.round((Date.now() - new Date(desde).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ${min % 60} min` : `${Math.floor(h / 24)} d`;
}

/** Aviso de que el cambio hay que repetirlo en el PMS. */
function avisoPms(texto) {
  if (!texto) return '';
  return `<div class="pms-notice">${icon('alert', 15)}<span>${esc(texto)}</span></div>`;
}

function chipPrioridad(p, n = null) {
  return `<span class="chip" style="color:${esc(p.color)};border-color:${esc(p.color)}55;background:${esc(p.color)}14">
    ${icon(p.icon, 12)}${esc(p.name)}${n === null ? '' : ` ${n}`}</span>`;
}

function filaSolicitud(s, puede) {
  return `<div class="solic" style="--pr:${esc(s.priority_color ?? '#64748b')}">
    <button class="solic-room" data-room="${s.room_id}">
      <span class="num">${esc(s.room_number)}</span>
      <span class="tiny muted">${esc(s.floor_name)}</span>
    </button>
    <div class="grow">
      <div class="row wrap" style="gap:6px;align-items:center">
        <span class="chip" style="color:${esc(s.priority_color)};border-color:${esc(s.priority_color)}55;background:${esc(s.priority_color)}14">
          ${icon(s.priority_icon ?? 'clock', 12)}${esc(s.priority_name)}</span>
        <span class="chip tiny" style="color:${esc(s.status_color)}">${icon(s.status_icon, 11)}${esc(s.status_name)}</span>
        ${s.status === 'pendiente'
          ? `<span class="tiny muted">${icon('clock', 11)} esperando ${espera(s.requested_at)}</span>`
          : `<span class="tiny muted">${esc(s.status)} · ${relative(s.closed_at)}</span>`}
      </div>
      ${s.note ? `<div class="small" style="margin-top:4px">${esc(s.note)}</div>` : ''}
      <div class="tiny muted" style="margin-top:3px">
        Pidió ${esc(s.requested_by_name)}${s.requested_department ? ` · ${esc(s.requested_department)}` : ''}
        · ${relative(s.requested_at)}
        ${s.closed_by_name ? ` · cerró ${esc(s.closed_by_name)}` : ''}
        ${s.closed_reason ? ` · ${esc(s.closed_reason)}` : ''}
      </div>
    </div>
    ${s.status === 'pendiente' && puede ? `<div class="row" style="gap:6px">
      <button class="btn sm" data-atender="${s.id}">${icon('check', 14)} Atendida</button>
      <button class="btn sm ghost" data-cancelar="${s.id}">${icon('x', 14)} Cancelar</button>
    </div>` : ''}
  </div>`;
}

function filaLimpia(r, puede) {
  return `<div class="solic" style="--pr:${esc(r.status_color)}">
    <button class="solic-room" data-room="${r.id}">
      <span class="num">${esc(r.number)}</span>
      <span class="tiny muted">${esc(r.floor_name)}</span>
    </button>
    <div class="grow">
      <span class="chip" style="color:${esc(r.status_color)};border-color:${esc(r.status_color)}55">
        ${icon('check-circle', 12)}${esc(r.status_name)}</span>
      ${r.status_changed_at ? `<div class="tiny muted" style="margin-top:3px">Lista desde ${relative(r.status_changed_at)}</div>` : ''}
    </div>
    ${puede ? `<button class="btn sm primary" data-entregar="${r.id}" data-numero="${esc(r.number)}">
      ${icon('door', 14)} Entregar</button>` : ''}
  </div>`;
}

export async function cleaningView(outlet) {
  const filtros = { floorId: '', priority: '' };

  const pintar = async () => {
    const data = await api.get('/api/cleaning', filtros);
    const puede = data.canRequest;

    $('[data-cola]', outlet).innerHTML = data.pending.length
      ? data.pending.map((s) => filaSolicitud(s, puede)).join('')
      : emptyState('No hay limpiezas pendientes de atender.', 'check-circle');

    $('[data-listas]', outlet).innerHTML = data.ready.length
      ? data.ready.map((r) => filaLimpia(r, puede)).join('')
      : emptyState('Ninguna habitación limpia y libre en este momento.', 'door');


    $('[data-resueltas]', outlet).innerHTML = data.resolved.length
      ? data.resolved.map((s) => filaSolicitud(s, false)).join('')
      : emptyState('Todavía no hay solicitudes cerradas.', 'history');

    $('[data-resumen]', outlet).innerHTML = `
      <span class="chip ${data.summary.total ? 'warn' : 'ok'}">${data.summary.total} pendiente${data.summary.total === 1 ? '' : 's'}</span>
      ${data.summary.porPrioridad.filter((p) => p.solicitudes).map((p) => chipPrioridad(p, p.solicitudes)).join('')}`;

    $('[data-listas-n]', outlet).textContent = data.readyTotal;
    $('[data-listas-nota]', outlet).innerHTML = data.readyTotal > data.ready.length
      ? `Mostrando las ${data.ready.length} que llevan más tiempo listas, de ${data.readyTotal}. Filtre por piso para verlas todas.`
      : '';
    return data;
  };

  const inicial = await api.get('/api/cleaning');
  const puede = inicial.canRequest;

  outlet.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Solicitudes de limpieza</h1>
        <p>Recepción pide, Ama de Llaves atiende. La cola se ordena sola: primero lo urgente y, a igual prioridad, lo que lleva más tiempo esperando.</p>
      </div>
      ${puede ? `<div class="row wrap">
        <button class="btn primary" data-pedir>${icon('plus', 15)} Solicitar limpieza</button>
      </div>` : ''}
    </div>

    ${avisoPms(inicial.pmsNotice)}

    <div class="card" style="margin-bottom:14px"><div class="card-body" style="padding:12px">
      <div class="grid-2">
        <div class="field"><label>Piso</label><select data-f="floorId"><option value="">Todos</option>
          ${state.floors.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Prioridad</label><select data-f="priority"><option value="">Todas</option>
          ${inicial.priorities.map((p) => `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join('')}</select></div>
      </div>
      <div class="row wrap" style="gap:6px" data-resumen></div>
    </div></div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px">
      <section class="card">
        <div class="card-head"><h2>Por atender</h2></div>
        <div class="card-body flush"><div class="list" data-cola>${spinner()}</div></div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Limpias, listas para entregar</h2>
          <span class="chip ok" data-listas-n>0</span>
        </div>
        <p class="tiny muted" data-listas-nota style="margin:0;padding:0 16px"></p>
        <div class="card-body flush"><div class="list" data-listas>${spinner()}</div></div>
      </section>
    </div>

    <section class="card" style="margin-top:16px">
      <div class="card-head"><h2>Cerradas recientemente</h2></div>
      <div class="card-body flush"><div class="list" data-resueltas>${spinner()}</div></div>
    </section>`;

  await pintar();

  // ------------------------------------------------------------- Acciones
  const pedir = async (roomIds = []) => {
    const m = modal({
      title: roomIds.length > 1 ? `Solicitar limpieza · ${roomIds.length} habitaciones` : 'Solicitar limpieza',
      body: `<form id="pedirForm">
        ${roomIds.length ? '' : `<div class="field">
          <label>Habitación <span style="color:var(--danger)">*</span></label>
          <input name="numero" type="text" inputmode="numeric" required placeholder="Ej. 618"
                 autocomplete="off" list="habitaciones">
          <span class="hint">Escriba el número tal como aparece en el rack.</span>
        </div>`}
        <div class="field">
          <label>Prioridad <span style="color:var(--danger)">*</span></label>
          <div class="opciones">
            ${inicial.priorities.slice().reverse().map((p) => `<label style="--pr:${esc(p.color)}">
              <input type="radio" name="priority" value="${esc(p.code)}" required>
              <span style="color:${esc(p.color)}">${esc(p.name)}</span></label>`).join('')}
          </div>
          <span class="hint">${inicial.priorities.map((p) => `<strong>${esc(p.name)}</strong>: ${esc(p.description ?? '')}`).join(' · ')}</span>
        </div>
        <div class="field">
          <label>Nota para Ama de Llaves</label>
          <textarea name="note" rows="2" placeholder="Qué hay que hacer y por qué corre prisa."></textarea>
        </div>
        <div class="readonly-note">${icon('shield', 14)}
          <span>Si la habitación ya tenía una solicitud pendiente no se duplica: sube de prioridad si la nueva es mayor.</span>
        </div>
      </form>`,
      footer: `<button class="btn" data-close>Cancelar</button>
               <button class="btn primary" form="pedirForm" type="submit">Solicitar</button>`,
    });

    $('#pedirForm', m.wrap).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = $('[type=submit]', m.footer);
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Guardando…';
      try {
        let ids = roomIds;
        if (!ids.length) {
          const buscada = await api.get('/api/rooms/search', { q: String(fd.get('numero')).trim() });
          if (!buscada.exact) throw new Error(`No existe la habitación ${fd.get('numero')}.`);
          ids = [buscada.exact.id];
        }
        const r = await api.post('/api/cleaning/requests', {
          roomIds: ids, priority: fd.get('priority'), note: fd.get('note') || null,
        });
        m.close();
        const partes = [
          r.creadas.length ? `${r.creadas.length} solicitada${r.creadas.length === 1 ? '' : 's'}` : null,
          r.elevadas.length ? `${r.elevadas.length} con prioridad elevada` : null,
          r.sinCambio.length ? `${r.sinCambio.length} ya estaba${r.sinCambio.length === 1 ? '' : 'n'} en cola` : null,
        ].filter(Boolean);
        toast(`${partes.join(' · ')}.`);
        await pintar();
      } catch (err) {
        toast(err.message, 'error', 5200);
        btn.disabled = false; btn.textContent = 'Solicitar';
      }
    });
  };

  const cerrarSolicitud = async (id, tipo) => {
    const esCancelar = tipo === 'cancelar';
    const m = modal({
      title: esCancelar ? 'Cancelar solicitud' : 'Marcar como atendida',
      body: `<form id="cerrarForm">
        <div class="field">
          <label>${esCancelar ? 'Motivo' : 'Nota'} ${esCancelar ? '<span style="color:var(--danger)">*</span>' : ''}</label>
          <textarea name="texto" rows="2" ${esCancelar ? 'required' : ''}
            placeholder="${esCancelar ? 'Por qué ya no hace falta.' : 'Opcional.'}"></textarea>
        </div>
        <div class="readonly-note">${icon('shield', 14)}
          <span>Queda registrado en el expediente de la habitación con su fecha, su hora y su autor.</span>
        </div>
      </form>`,
      footer: `<button class="btn" data-close>Volver</button>
               <button class="btn ${esCancelar ? '' : 'primary'}" form="cerrarForm" type="submit">
                 ${esCancelar ? 'Cancelar solicitud' : 'Marcar atendida'}</button>`,
    });
    $('#cerrarForm', m.wrap).addEventListener('submit', async (e) => {
      e.preventDefault();
      const texto = new FormData(e.target).get('texto');
      const btn = $('[type=submit]', m.footer);
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Guardando…';
      try {
        await api.post(`/api/cleaning/requests/${id}/${esCancelar ? 'cancel' : 'attend'}`,
          esCancelar ? { reason: texto } : { note: texto || null });
        m.close();
        toast(esCancelar ? 'Solicitud cancelada.' : 'Solicitud marcada como atendida.');
        await pintar();
      } catch (err) {
        toast(err.message, 'error', 5200);
        btn.disabled = false; btn.textContent = esCancelar ? 'Cancelar solicitud' : 'Marcar atendida';
      }
    });
  };

  /** Tomar una habitación limpia para entregarla al huésped que llega. */
  const entregar = async (roomId, numero) => {
    const m = modal({
      title: `Entregar la habitación ${numero}`,
      body: `<form id="entregarForm">
        ${avisoPms(inicial.pmsNotice)}
        <div class="field">
          <label>Comentario</label>
          <textarea name="comment" rows="2" placeholder="A nombre de quién, o cualquier detalle de la entrega."></textarea>
        </div>
        <div class="readonly-note">${icon('shield', 14)}
          <span>La habitación pasa a <strong>Entrada nueva</strong> y deja de contar como disponible.
          Fecha, hora y usuario los pone el servidor.</span>
        </div>
      </form>`,
      footer: `<button class="btn" data-close>Cancelar</button>
               <button class="btn primary" form="entregarForm" type="submit">Entregar habitación</button>`,
    });
    $('#entregarForm', m.wrap).addEventListener('submit', async (e) => {
      e.preventDefault();
      const comment = new FormData(e.target).get('comment');
      const btn = $('[type=submit]', m.footer);
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Guardando…';
      try {
        await api.post(`/api/rooms/${roomId}/movements`, { movementType: 'DELIVER', comment: comment || null });
        m.close();
        toast(`Habitación ${numero} entregada. ${inicial.pmsNotice ?? ''}`.trim(), 'warn', 7000);
        await pintar();
      } catch (err) {
        toast(err.message, 'error', 5200);
        btn.disabled = false; btn.textContent = 'Entregar habitación';
      }
    });
  };

  outlet.addEventListener('change', (e) => {
    const f = e.target.dataset?.f;
    if (!f) return;
    filtros[f] = e.target.value;
    pintar();
  });

  outlet.addEventListener('click', (e) => {
    const pedirBtn = e.target.closest('[data-pedir]');
    if (pedirBtn) return pedir();
    const atender = e.target.closest('[data-atender]');
    if (atender) return cerrarSolicitud(atender.dataset.atender, 'atender');
    const cancelar = e.target.closest('[data-cancelar]');
    if (cancelar) return cerrarSolicitud(cancelar.dataset.cancelar, 'cancelar');
    const entregarBtn = e.target.closest('[data-entregar]');
    if (entregarBtn) return entregar(Number(entregarBtn.dataset.entregar), entregarBtn.dataset.numero);
    const room = e.target.closest('[data-room]');
    if (room) return openRoom(Number(room.dataset.room), { onChange: pintar });
    return undefined;
  });
}
