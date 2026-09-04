import { api } from './api.js';
import { icon } from './icons.js';
import { $, $$, el, esc, toast, debounce, initials, drawer, emptyState, relative } from './ui.js';
import { state, can, canAny, loadSession, loadBootstrap, refreshNotifications } from './store.js';
import { register, setOutlet, render, navigate, parseHash } from './router.js';
import { loginView, passwordPrompt } from './views/login.js';
import { dashboardView } from './views/dashboard.js';
import { floorsView, attentionView, activityView, managementView, reportsView, auditView } from './views/pages.js';
import { adminView } from './views/admin.js';
import { openRoom } from './views/room.js';

const NAV = [
  { path: 'inicio',     label: 'Inicio',      icon: 'home',   perm: 'room.view' },
  { path: 'pisos',      label: 'Pisos',       icon: 'grid',   perm: 'room.view' },
  { path: 'atencion',   label: 'Atención',    icon: 'alert',  perm: 'room.view' },
  { path: 'actividad',  label: 'Actividad',   icon: 'history',perm: 'history.view' },
  { path: 'gerencial',  label: 'Gerencial',   icon: 'chart',  perm: 'dashboard.manage' },
  { path: 'reportes',   label: 'Reportes',    icon: 'download', perm: 'report.view' },
  { path: 'auditoria',  label: 'Auditoría',   icon: 'shield', perm: 'audit.view' },
  { path: 'admin',      label: 'Admin',       icon: 'settings', perms: ['admin.rooms', 'admin.users', 'admin.catalog', 'admin.settings'] },
];

register('inicio', dashboardView);
register('pisos', floorsView);
register('atencion', attentionView);
register('actividad', activityView);
register('gerencial', managementView);
register('reportes', reportsView);
register('auditoria', auditView);
register('admin', adminView);

// --------------------------------------------------------------- Cabecera
function appShell() {
  const u = state.user;
  const nav = NAV.filter((n) => (n.perms ? canAny(...n.perms) : can(n.perm)));

  const shell = el(`
    <div>
      <header class="appbar">
        <div class="brand">${icon('layers', 22)}
          <div>CDH<small>${esc(state.hotel.name)}</small></div></div>
        <nav>${nav.map((n) => `<button data-nav="${n.path}" title="${esc(n.label)}" aria-label="${esc(n.label)}">${icon(n.icon, 16)}<span>${esc(n.label)}</span></button>`).join('')}</nav>
        <div class="spacer"></div>
        <div class="search-wrap hide-sm">
          ${icon('search', 16)}
          <input type="search" id="globalSearch" placeholder="Buscar habitación, piso o incidencia…"
                 autocomplete="off" aria-label="Buscar" style="background:rgba(255,255,255,.16);border-color:transparent;color:#fff">
          <div class="search-results" hidden></div>
        </div>
        <button class="icon-btn" data-notif aria-label="Notificaciones">${icon('bell', 19)}<span class="badge-dot" hidden></span></button>
        <button class="who" data-user aria-label="Cuenta">
          <span class="avatar">${esc(initials(u.fullName))}</span>
          <span class="hide-sm" style="text-align:left;line-height:1.2">
            <span style="display:block;font-size:12.5px;font-weight:650">${esc(u.fullName)}</span>
            <span style="display:block;font-size:10.5px;opacity:.8">${esc(u.role.name)}</span>
          </span>
        </button>
      </header>
      <main data-outlet></main>
    </div>`);

  shell.querySelector('nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nav]');
    if (b) navigate(b.dataset.nav);
  });
  $('[data-notif]', shell).addEventListener('click', notificationsPanel);
  $('[data-user]', shell).addEventListener('click', accountPanel);
  wireSearch(shell);
  return shell;
}

function markActive() {
  const { path } = parseHash();
  $$('[data-nav]').forEach((b) =>
    b.setAttribute('aria-current', b.dataset.nav === path ? 'page' : 'false'));
}

// -------------------------------------------------------- Búsqueda global
function wireSearch(shell) {
  const input = $('#globalSearch', shell);
  const box = $('.search-results', shell);
  let items = [];
  let cursor = -1;

  const close = () => { box.hidden = true; cursor = -1; };
  const paint = () => $$('button', box).forEach((b, i) => b.classList.toggle('active', i === cursor));

  const run = debounce(async (q) => {
    if (!q.trim()) return close();
    const data = await api.get('/api/rooms/search', { q });
    items = [];
    let html = '';

    if (data.exact) {
      items.push({ kind: 'room', id: data.exact.id });
      html += `<div class="sr-group">Coincidencia exacta</div>
        <button><span class="lead bold" style="width:46px;font-size:16px">${esc(data.exact.number)}</span>
          <span class="grow"><span class="bold">${esc(data.exact.floor_name)}</span>
            <div class="tiny muted">${esc(data.exact.status_name)}</div></span>
          ${icon('chevron', 15)}</button>`;
    }
    const others = data.rooms.filter((r) => r.id !== data.exact?.id).slice(0, 8);
    if (others.length) {
      html += '<div class="sr-group">Habitaciones</div>';
      for (const r of others) {
        items.push({ kind: 'room', id: r.id });
        html += `<button><span class="lead bold" style="width:46px">${esc(r.number)}</span>
          <span class="grow">${esc(r.floor_name)}<div class="tiny muted">${esc(r.status_name)}${
            r.incidentCount ? ` · ${r.incidentCount} incidencia(s)` : ''}</div></span></button>`;
      }
    }
    if (data.floors.length) {
      html += '<div class="sr-group">Pisos</div>';
      for (const f of data.floors) {
        items.push({ kind: 'floor', id: f.id });
        html += `<button>${icon('grid', 15)}<span class="grow">${esc(f.name)}</span></button>`;
      }
    }
    if (data.movements.length && can('history.view')) {
      html += '<div class="sr-group">Movimientos</div>';
      for (const m of data.movements.slice(0, 6)) {
        items.push({ kind: 'room', id: m.room_id });
        html += `<button><span class="lead bold" style="width:46px">${esc(m.room_number)}</span>
          <span class="grow"><span class="small">${esc(m.action)}</span>
            <div class="tiny muted">${esc(m.local_date)} · ${esc(m.user_name)}</div></span></button>`;
      }
    }
    if (!items.length) html = `<div class="empty" style="padding:22px">${icon('search', 26)}<p>Sin resultados para “${esc(q)}”.</p></div>`;

    box.innerHTML = html;
    box.hidden = false;
    cursor = -1;
    $$('button', box).forEach((b, i) => b.addEventListener('click', () => pick(i)));
  }, 220);

  const pick = (i) => {
    const it = items[i];
    if (!it) return;
    close(); input.value = ''; input.blur();
    if (it.kind === 'room') openRoom(it.id, { onChange: render });
    else navigate(`pisos/${it.id}`);
  };

  input.addEventListener('input', (e) => run(e.target.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return close();
    if (box.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = (cursor + 1) % items.length; paint(); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); cursor = (cursor - 1 + items.length) % items.length; paint(); }
    if (e.key === 'Enter')     { e.preventDefault(); pick(cursor === -1 ? 0 : cursor); }
    return undefined;
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) close(); });
}

// ---------------------------------------------------------- Notificaciones
async function notificationsPanel() {
  const d = drawer({
    title: 'Notificaciones',
    subtitle: 'Sólo eventos relevantes: mantenimiento crítico, bloqueos e incidencias.',
    body: '<div class="loading"><div class="spinner dark"></div></div>',
    width: '460px',
  });
  const load = async () => {
    const data = await refreshNotifications();
    updateBadge();
    d.body.innerHTML = data.items.length ? `<div class="list card">${data.items.map((n) => `
      <button class="list-item" data-room="${n.room_id ?? ''}" data-notif-id="${n.id}">
        <span class="lead" style="color:${n.severity === 'critica' ? 'var(--danger)' : 'var(--warn)'}">${esc(n.room_number ?? '—')}</span>
        <span class="grow"><span class="bold" style="font-size:13px">${esc(n.title)}</span>
          <div class="tiny muted">${esc(n.body ?? '')}</div>
          <div class="tiny muted">${relative(n.created_at)}</div></span>
        <span class="chip ${n.severity === 'critica' ? 'danger' : 'warn'} tiny">${esc(n.severity)}</span>
      </button>`).join('')}</div>`
      : emptyState('Sin notificaciones pendientes.', 'check-circle');
  };
  d.body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-notif-id]');
    if (!b) return;
    await api.post(`/api/notifications/${b.dataset.notifId}/read`).catch(() => {});
    if (b.dataset.room) { d.close(); openRoom(Number(b.dataset.room), { onChange: render }); }
  });
  await load();
}

function updateBadge() {
  const dot = $('[data-notif] .badge-dot');
  if (!dot) return;
  const n = state.notifications.unread ?? 0;
  dot.textContent = n > 99 ? '99+' : String(n);
  dot.hidden = n === 0;
}

// ------------------------------------------------------------------ Cuenta
function accountPanel() {
  const u = state.user;
  const d = drawer({
    title: u.fullName,
    subtitle: `${u.role.name}${u.department ? ` · ${u.department.name}` : ''}`,
    width: '440px',
    body: `<div class="card"><div class="card-body">
        <div class="field"><label>Usuario</label><input value="${esc(u.username)}" disabled></div>
        <div class="field"><label>Correo</label><input value="${esc(u.email ?? '—')}" disabled></div>
        <div class="field"><label>Zona horaria del hotel</label><input value="${esc(state.hotel.timezone)}" disabled>
          <span class="hint">Todos los movimientos usan el reloj del servidor, no el del dispositivo.</span></div>
      </div></div>
      <div class="card" style="margin-top:14px">
        <div class="card-head"><h2>Permisos activos</h2></div>
        <div class="card-body"><div class="row wrap" style="gap:6px">
          ${u.permissions.map((p) => `<span class="chip tiny mono">${esc(p)}</span>`).join('')}
        </div></div>
      </div>
      <div class="stack" style="margin-top:16px">
        <button class="btn block" data-pw>${icon('lock', 15)} Cambiar contraseña</button>
        <button class="btn danger block" data-logout>${icon('logout', 15)} Cerrar sesión</button>
      </div>`,
  });
  $('[data-pw]', d.panel).addEventListener('click', () => { d.close(); passwordPrompt(false); });
  $('[data-logout]', d.panel).addEventListener('click', async () => {
    await api.post('/api/auth/logout').catch(() => {});
    location.hash = '';
    location.reload();
  });
}

// ------------------------------------------------------------------- Boot
async function start() {
  const root = $('#app');
  const user = await loadSession();

  if (!user) {
    root.replaceChildren(loginView(async () => { location.reload(); }));
    return;
  }

  await loadBootstrap();
  const shell = appShell();
  root.replaceChildren(shell);
  setOutlet($('[data-outlet]', shell));

  if (!location.hash) location.hash = '#/inicio';
  await render();
  markActive();
  document.addEventListener('route:changed', markActive);

  refreshNotifications().then(updateBadge);
  setInterval(() => refreshNotifications().then(updateBadge), 60_000);

  if (user.mustChangePassword) {
    toast('Por seguridad, establezca una contraseña propia.', 'warn', 6000);
    await passwordPrompt(true);
  }
}

// Una sesión caducada devuelve al inicio de sesión sin dejar la vista rota.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.status === 401) { toast('Su sesión expiró. Vuelva a iniciar sesión.', 'warn'); setTimeout(() => location.reload(), 1400); }
});

start();
