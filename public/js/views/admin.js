import { api } from '../api.js';
import { icon } from '../icons.js';
import { $, $$, el, esc, emptyState, spinner, toast, modal, confirmDialog, fmtDate } from '../ui.js';
import { state, loadBootstrap, can } from '../store.js';
import { resetQuickActions } from './room.js';

/** Convierte "A, B, C" en ["A","B","C"]; cadena vacía devuelve null. */
const toList = (raw) => {
  const parts = String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : null;
};

const yes = (v) => (v ? `<span class="chip ok tiny">${icon('check', 11)}Sí</span>` : '<span class="chip tiny">No</span>');
const activeChip = (v) => (v ? '<span class="chip ok tiny">Activo</span>' : '<span class="chip tiny">Inactivo</span>');

/** Formulario genérico en modal para catálogos. */
function formModal({ title, fields, values = {}, submitLabel = 'Guardar' }) {
  return new Promise((resolve) => {
    const body = `<form id="af">${fields.map((f) => {
      const v = values[f.name] ?? f.default ?? '';
      if (f.type === 'checkbox') {
        return `<div class="field"><label style="flex-direction:row;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" name="${f.name}" ${v ? 'checked' : ''} style="width:18px;height:18px;min-height:auto">
          ${esc(f.label)}</label>${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`;
      }
      if (f.type === 'select') {
        return `<div class="field"><label>${esc(f.label)}</label>
          <select name="${f.name}" ${f.required ? 'required' : ''}>
            ${f.allowEmpty ? '<option value="">— Ninguno —</option>' : ''}
            ${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`;
      }
      if (f.type === 'textarea') {
        return `<div class="field"><label>${esc(f.label)}</label>
          <textarea name="${f.name}" rows="${f.rows ?? 2}" ${f.required ? 'required' : ''}>${esc(v)}</textarea>
          ${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`;
      }
      return `<div class="field"><label>${esc(f.label)}</label>
        <input type="${f.type ?? 'text'}" name="${f.name}" value="${esc(v)}"
          ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}
          ${f.min !== undefined ? `min="${f.min}"` : ''}>
        ${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`;
    }).join('')}
    <div class="field"><label>Motivo del cambio</label>
      <input type="text" name="reason" placeholder="Queda registrado en la bitácora (opcional)"></div>
    </form>`;

    let settled = false;
    const m = modal({
      title, body,
      footer: `<button class="btn" data-close>Cancelar</button>
               <button class="btn primary" form="af" type="submit">${esc(submitLabel)}</button>`,
      onClose: () => { if (!settled) resolve(null); },
    });
    $('#af', m.wrap).addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) {
        const input = e.target.elements[f.name];
        out[f.name] = f.type === 'checkbox' ? input.checked : (input.value === '' ? null : input.value);
      }
      out.reason = e.target.elements.reason.value || null;
      settled = true; m.close(); resolve(out);
    });
  });
}

const section = (title, subtitle, actionHtml = '') => `
  <div class="card"><div class="card-head">
    <div><h2>${esc(title)}</h2>${subtitle ? `<p class="tiny muted" style="margin:3px 0 0">${esc(subtitle)}</p>` : ''}</div>
    ${actionHtml}</div>
    <div class="card-body flush"><div class="table-scroll" data-body>${spinner()}</div></div>
  </div>`;

// ------------------------------------------------------------ Habitaciones
async function roomsTab(box) {
  box.innerHTML = section('Catálogo de habitaciones',
    'Alta, edición y baja lógica. Desactivar conserva el historial completo.',
    '<button class="btn primary sm" data-new>' + icon('plus', 14) + ' Nueva habitación</button>');
  const body = $('[data-body]', box);

  const load = async () => {
    body.innerHTML = spinner();
    const { items, gridColumns } = await api.get('/api/admin/rooms');
    const active = items.filter((r) => r.active).length;
    body.innerHTML = `<table>
      <thead><tr><th>Habitación</th><th>Piso</th><th>Tipo</th><th>Estado</th>
        <th>Posición</th><th>Movimientos</th><th>Activa</th><th></th></tr></thead>
      <tbody>${items.map((r) => `<tr>
        <td class="bold mono">${esc(r.number)}</td><td>${esc(r.floor_name)}</td>
        <td>${esc(r.type_name ?? '—')}</td><td>${esc(r.status_name)}</td>
        <td class="tiny muted mono">fila ${r.grid_row} / col ${r.grid_col}</td>
        <td class="mono">${r.movements}</td><td>${activeChip(r.active)}</td>
        <td><button class="btn sm ghost" data-edit="${r.id}">${icon('edit', 14)}</button></td>
      </tr>`).join('')}</tbody></table>`;
    $('.card-head p', box).textContent =
      `${active} activas de ${items.length} · objetivo ${state.hotel.targetRooms} · cuadrícula de ${gridColumns} columnas`;
    body.dataset.rooms = JSON.stringify(items);
  };

  const floorOpts = () => state.floors.map((f) => ({ value: f.id, label: f.name }));
  const typeOpts = () => state.roomTypes.map((t) => ({ value: t.id, label: t.name }));

  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-new]')) {
      const v = await formModal({
        title: 'Nueva habitación',
        fields: [
          { name: 'number', label: 'Número', required: true, placeholder: 'Ej. 923' },
          { name: 'floorId', label: 'Piso', type: 'select', options: floorOpts(), required: true },
          { name: 'roomTypeId', label: 'Tipo', type: 'select', options: typeOpts(), allowEmpty: true },
          { name: 'statusCode', label: 'Estado inicial', type: 'select',
            options: state.statuses.map((s) => ({ value: s.code, label: s.name })), default: 'DISPONIBLE' },
          { name: 'gridRow', label: 'Fila del mapa', type: 'number',
            hint: 'Normalmente el número de piso. Define en qué renglón del rack aparece.' },
          { name: 'gridCol', label: 'Columna del mapa (1–19)', type: 'number', min: 1,
            hint: 'Posición A–S. Déjelo vacío para colocarla al final de la fila.' },
        ],
        submitLabel: 'Crear habitación',
      });
      if (!v) return;
      try { await api.post('/api/admin/rooms', v); toast(`Habitación ${v.number} creada.`); await loadBootstrap(); await load(); }
      catch (err) { toast(err.message, 'error', 5200); }
    }

    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      const rooms = JSON.parse(body.dataset.rooms ?? '[]');
      const r = rooms.find((x) => x.id === Number(editBtn.dataset.edit));
      const v = await formModal({
        title: `Habitación ${r.number}`,
        values: { number: r.number, floorId: r.floor_id, roomTypeId: r.room_type_id,
          gridRow: r.grid_row, gridCol: r.grid_col, notes: r.notes, active: !!r.active },
        fields: [
          { name: 'number', label: 'Número', required: true },
          { name: 'floorId', label: 'Piso', type: 'select', options: floorOpts(), required: true },
          { name: 'roomTypeId', label: 'Tipo', type: 'select', options: typeOpts(), allowEmpty: true },
          { name: 'gridRow', label: 'Fila del mapa', type: 'number' },
          { name: 'gridCol', label: 'Columna del mapa (1–19)', type: 'number', min: 1 },
          { name: 'notes', label: 'Notas', type: 'textarea' },
          { name: 'active', label: 'Habitación activa', type: 'checkbox',
            hint: 'Al desactivarla deja de operarse, pero su historial se conserva íntegro.' },
        ],
      });
      if (!v) return;
      try { await api.put(`/api/admin/rooms/${r.id}`, v); toast('Habitación actualizada.'); await loadBootstrap(); await load(); }
      catch (err) { toast(err.message, 'error', 5200); }
    }
  });
  await load();
}

// --------------------------------------------------------- Catálogo genérico
function catalogTab(box, { path, title, subtitle, columns, fields, newLabel, entityName,
  afterChange = null, transform = (v) => v }) {
  box.innerHTML = section(title, subtitle,
    `<button class="btn primary sm" data-new>${icon('plus', 14)} ${esc(newLabel)}</button>`);
  const body = $('[data-body]', box);

  const load = async () => {
    body.innerHTML = spinner();
    const { items } = await api.get(`/api/admin/${path}`);
    body.dataset.items = JSON.stringify(items);
    body.innerHTML = items.length ? `<table>
      <thead><tr>${columns.map((c) => `<th>${esc(c.header)}</th>`).join('')}<th></th></tr></thead>
      <tbody>${items.map((it) => `<tr>
        ${columns.map((c) => `<td>${c.render ? c.render(it) : esc(it[c.key] ?? '—')}</td>`).join('')}
        <td style="white-space:nowrap">
          <button class="btn sm ghost" data-edit="${it.id}">${icon('edit', 14)}</button>
          ${it.active && !it.is_system ? `<button class="btn sm ghost" data-off="${it.id}" title="Desactivar">${icon('ban', 14)}</button>` : ''}
        </td></tr>`).join('')}</tbody></table>` : emptyState('Sin registros.');
  };

  box.addEventListener('click', async (e) => {
    const items = () => JSON.parse(body.dataset.items ?? '[]');

    if (e.target.closest('[data-new]')) {
      const v = await formModal({ title: newLabel, fields: fields(), submitLabel: 'Crear' });
      if (!v) return;
      try { await api.post(`/api/admin/${path}`, transform(v)); toast(`${entityName} creado.`); await load(); await afterChange?.(); }
      catch (err) { toast(err.message, 'error', 5200); }
    }

    const ed = e.target.closest('[data-edit]');
    if (ed) {
      const it = items().find((x) => x.id === Number(ed.dataset.edit));
      const v = await formModal({ title: `Editar ${entityName.toLowerCase()}`, fields: fields(it), values: it });
      if (!v) return;
      try { await api.put(`/api/admin/${path}/${it.id}`, transform(v)); toast(`${entityName} actualizado.`); await load(); await afterChange?.(); }
      catch (err) { toast(err.message, 'error', 5200); }
    }

    const off = e.target.closest('[data-off]');
    if (off) {
      const it = items().find((x) => x.id === Number(off.dataset.off));
      const ok = await confirmDialog({
        title: `Desactivar ${entityName.toLowerCase()}`,
        message: `¿Desactivar <strong>${esc(it.name ?? it.label)}</strong>? No se elimina nada: deja de estar disponible y el historial se conserva.`,
        confirmLabel: 'Desactivar', danger: true,
      });
      if (!ok) return;
      try { await api.del(`/api/admin/${path}/${it.id}`); toast(`${entityName} desactivado.`); await load(); await afterChange?.(); }
      catch (err) { toast(err.message, 'error', 5200); }
    }
  });
  return load();
}

// ---------------------------------------------------------------- Usuarios
async function usersTab(box) {
  box.innerHTML = `${section('Usuarios', 'Roles, departamentos y acceso.',
    '<button class="btn primary sm" data-new>' + icon('plus', 14) + ' Nuevo usuario</button>')}
    <div style="margin-top:16px">${section('Roles y permisos',
      'Cada permiso es independiente. Los cambios revocan las sesiones abiertas del rol.')}</div>`;
  const [usersBox, rolesBox] = $$('[data-body]', box);

  let rolesData = { roles: [], permissions: [] };

  const loadUsers = async () => {
    usersBox.innerHTML = spinner();
    const { items } = await api.get('/api/admin/users');
    usersBox.dataset.items = JSON.stringify(items);
    usersBox.innerHTML = `<table>
      <thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Departamento</th>
        <th>Último acceso</th><th>Movs.</th><th>Estado</th><th></th></tr></thead>
      <tbody>${items.map((u) => `<tr>
        <td class="bold">${esc(u.username)}</td><td>${esc(u.full_name)}</td>
        <td><span class="chip plum tiny">${esc(u.role_name)}</span></td>
        <td>${esc(u.department_name ?? '—')}</td>
        <td class="tiny muted">${u.last_login_at ? new Date(u.last_login_at).toLocaleString('es-MX') : 'nunca'}</td>
        <td class="mono">${u.movements}</td><td>${activeChip(u.active)}</td>
        <td><button class="btn sm ghost" data-edit-user="${u.id}">${icon('edit', 14)}</button></td>
      </tr>`).join('')}</tbody></table>`;
  };

  const loadRoles = async () => {
    rolesBox.innerHTML = spinner();
    rolesData = await api.get('/api/admin/roles');
    const groups = [...new Set(rolesData.permissions.map((p) => p.grp))];
    rolesBox.innerHTML = `<table>
      <thead><tr><th>Rol</th><th>Alcance</th>${groups.map((g) => `<th>${esc(g)}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rolesData.roles.map((r) => `<tr>
        <td><div class="bold">${esc(r.name)}</div><div class="tiny muted">${esc(r.description ?? '')}</div></td>
        <td>${r.department_scope
          ? '<span class="chip tiny">Sólo su departamento</span>'
          : '<span class="chip info tiny">Todo el hotel</span>'}</td>
        ${groups.map((g) => {
          const total = rolesData.permissions.filter((p) => p.grp === g).length;
          const have = rolesData.permissions.filter((p) => p.grp === g && r.permissions.includes(p.code)).length;
          return `<td class="mono tiny ${have ? '' : 'muted'}">${have}/${total}</td>`;
        }).join('')}
        <td><button class="btn sm ghost" data-perms="${r.id}">${icon('shield', 14)}</button></td>
      </tr>`).join('')}</tbody></table>`;
  };

  const userFields = (u = null) => [
    ...(u ? [] : [{ name: 'username', label: 'Usuario', required: true, placeholder: 'nombre.apellido' }]),
    { name: 'fullName', label: 'Nombre completo', required: true },
    { name: 'email', label: 'Correo', type: 'email' },
    { name: 'phone', label: 'Teléfono' },
    { name: 'roleId', label: 'Rol', type: 'select', required: true,
      options: rolesData.roles.filter((r) => r.active).map((r) => ({ value: r.id, label: r.name })) },
    { name: 'departmentId', label: 'Departamento', type: 'select', allowEmpty: true,
      options: state.departments.map((d) => ({ value: d.id, label: d.name })) },
    { name: 'password', label: u ? 'Nueva contraseña (opcional)' : 'Contraseña', type: 'password',
      required: !u, hint: 'Mínimo 8 caracteres.' },
    { name: 'mustChangePassword', label: 'Obligar cambio en el próximo acceso', type: 'checkbox', default: true },
    ...(u ? [{ name: 'active', label: 'Usuario activo', type: 'checkbox' }] : []),
  ];

  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-new]')) {
      const v = await formModal({ title: 'Nuevo usuario', fields: userFields(), submitLabel: 'Crear usuario' });
      if (!v) return;
      try { await api.post('/api/admin/users', v); toast('Usuario creado.'); await loadUsers(); await loadBootstrap(); }
      catch (err) { toast(err.message, 'error', 5200); }
    }

    const eu = e.target.closest('[data-edit-user]');
    if (eu) {
      const u = JSON.parse(usersBox.dataset.items).find((x) => x.id === Number(eu.dataset.editUser));
      const v = await formModal({
        title: `Usuario ${u.username}`,
        values: { fullName: u.full_name, email: u.email, phone: u.phone, roleId: u.role_id,
          departmentId: u.department_id, active: !!u.active, mustChangePassword: !!u.must_change_password },
        fields: userFields(u),
      });
      if (!v) return;
      if (!v.password) delete v.password;
      try { await api.put(`/api/admin/users/${u.id}`, v); toast('Usuario actualizado.'); await loadUsers(); await loadBootstrap(); }
      catch (err) { toast(err.message, 'error', 5200); }
    }

    const pb = e.target.closest('[data-perms]');
    if (pb) {
      const role = rolesData.roles.find((r) => r.id === Number(pb.dataset.perms));
      const groups = [...new Set(rolesData.permissions.map((p) => p.grp))];
      const m = modal({
        title: `Permisos — ${role.name}`,
        body: `<form id="pf">
          ${role.code === 'ADMIN' ? '<div class="alert warn">El rol Administrador conserva siempre todos los permisos.</div>' : ''}
          ${groups.map((g) => `<fieldset style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:11px">
            <legend class="tiny bold" style="padding:0 6px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.05em">${esc(g)}</legend>
            ${rolesData.permissions.filter((p) => p.grp === g).map((p) => `
              <label style="display:flex;align-items:center;gap:9px;padding:5px 0;cursor:pointer;font-size:13px">
                <input type="checkbox" name="perm" value="${esc(p.code)}" ${role.permissions.includes(p.code) ? 'checked' : ''}
                  ${role.code === 'ADMIN' ? 'disabled' : ''} style="width:18px;height:18px;min-height:auto">
                <span>${esc(p.name)}<span class="tiny muted"> · ${esc(p.code)}</span></span></label>`).join('')}
          </fieldset>`).join('')}
          <div class="field"><label>Motivo</label><input type="text" name="reason" placeholder="Queda en la bitácora"></div>
        </form>`,
        footer: `<button class="btn" data-close>Cancelar</button>
                 ${role.code === 'ADMIN' ? '' : '<button class="btn primary" form="pf" type="submit">Guardar permisos</button>'}`,
      });
      $('#pf', m.wrap).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const perms = $$('[name=perm]:checked', ev.target).map((i) => i.value);
        try {
          await api.put(`/api/admin/roles/${role.id}/permissions`, { permissions: perms, reason: ev.target.reason.value || null });
          m.close(); toast('Permisos actualizados.'); await loadRoles(); resetQuickActions();
        } catch (err) { toast(err.message, 'error', 5200); }
      });
    }
  });

  await loadRoles();
  await loadUsers();
}

// ----------------------------------------------------------- Configuración
async function settingsTab(box) {
  box.innerHTML = section('Configuraciones', 'Zona horaria, umbrales y notificaciones del sistema.');
  const body = $('[data-body]', box);
  const load = async () => {
    body.innerHTML = spinner();
    const { items } = await api.get('/api/admin/settings');
    const groups = [...new Set(items.map((s) => s.grp))];
    body.innerHTML = groups.map((g) => `
      <div style="padding:14px 16px;border-bottom:1px solid var(--line)">
        <h3 class="tiny bold" style="text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin-bottom:10px">${esc(g)}</h3>
        ${items.filter((s) => s.grp === g).map((s) => `
          <div class="row-between" style="padding:7px 0;gap:14px;flex-wrap:wrap">
            <div class="grow"><div style="font-weight:600;font-size:13px">${esc(s.label ?? s.key)}</div>
              <div class="tiny muted mono">${esc(s.key)}${s.updated_at ? ` · actualizado ${fmtDate(s.updated_at.slice(0, 10))}` : ''}</div></div>
            <div class="row" style="gap:8px">
              ${s.type === 'boolean'
                ? `<select data-key="${esc(s.key)}" style="width:120px">
                     <option value="1" ${s.value === '1' ? 'selected' : ''}>Activado</option>
                     <option value="0" ${s.value !== '1' ? 'selected' : ''}>Desactivado</option></select>`
                : `<input type="${s.type === 'number' ? 'number' : 'text'}" value="${esc(s.value ?? '')}"
                     data-key="${esc(s.key)}" style="width:230px">`}
              <button class="btn sm" data-save="${esc(s.key)}">Guardar</button>
            </div>
          </div>`).join('')}
      </div>`).join('');
  };

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-save]');
    if (!b) return;
    const key = b.dataset.save;
    const input = $(`[data-key="${CSS.escape(key)}"]`, box);
    try {
      await api.put(`/api/admin/settings/${key}`, { value: input.value });
      toast('Configuración guardada.');
      await loadBootstrap();
      if (key === 'timezone') toast('Los nuevos movimientos usarán la zona horaria actualizada.', 'warn', 4600);
      await load();
    } catch (err) { toast(err.message, 'error', 5200); }
  });
  await load();
}

// ================================================================== Vista
export async function adminView(outlet) {
  const tabs = [
    { id: 'rooms',      label: 'Habitaciones',  perm: 'admin.rooms' },
    { id: 'floors',     label: 'Pisos',         perm: 'admin.rooms' },
    { id: 'statuses',   label: 'Estados',       perm: 'admin.catalog' },
    { id: 'categories', label: 'Categorías',    perm: 'admin.catalog' },
    { id: 'fields',     label: 'Campos',        perm: 'admin.catalog' },
    { id: 'actions',    label: 'Acciones',      perm: 'admin.catalog' },
    { id: 'departments',label: 'Departamentos', perm: 'admin.catalog' },
    { id: 'users',      label: 'Usuarios y roles', perm: 'admin.users' },
    { id: 'settings',   label: 'Configuración', perm: 'admin.settings' },
  ].filter((t) => can(t.perm));

  if (!tabs.length) {
    outlet.innerHTML = `<div class="card"><div class="card-body">${
      emptyState('Su rol no tiene acceso a la administración del sistema.', 'lock')}</div></div>`;
    return;
  }

  outlet.innerHTML = `
    <div class="page-head"><div><h1>Administración</h1>
      <p>Nada se elimina: las bajas son lógicas y el historial se conserva siempre.</p></div></div>
    <div class="tabs" role="tablist">${tabs.map((t, i) =>
      `<button role="tab" data-tab="${t.id}" aria-selected="${i === 0}">${esc(t.label)}</button>`).join('')}</div>
    <div data-panel></div>`;

  const panel = $('[data-panel]', outlet);
  const show = async (id) => {
    $$('[data-tab]', outlet).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    const box = el('<div></div>');
    panel.replaceChildren(box);

    if (id === 'rooms')  return roomsTab(box);
    if (id === 'users')  return usersTab(box);
    if (id === 'settings') return settingsTab(box);

    if (id === 'floors') {
      return catalogTab(box, {
        path: 'floors', title: 'Pisos', newLabel: 'Nuevo piso', entityName: 'Piso',
        subtitle: 'Cada piso es un renglón del mapa del rack.',
        columns: [{ key: 'number', header: 'Número' }, { key: 'name', header: 'Nombre' },
          { key: 'sort_order', header: 'Orden' }, { header: 'Activo', render: (r) => activeChip(r.active) }],
        fields: () => [
          { name: 'number', label: 'Número de piso', type: 'number', required: true },
          { name: 'name', label: 'Nombre', required: true, placeholder: 'Piso 12' },
          { name: 'sort_order', label: 'Orden de aparición', type: 'number' },
          { name: 'active', label: 'Activo', type: 'checkbox', default: true },
        ],
        afterChange: loadBootstrap,
      });
    }

    if (id === 'statuses') {
      return catalogTab(box, {
        path: 'statuses', title: 'Estados de habitación', newLabel: 'Nuevo estado', entityName: 'Estado',
        subtitle: 'Las banderas definen a qué indicador del dashboard suma cada estado.',
        columns: [
          { header: 'Estado', render: (s) => `<span class="row" style="gap:7px;color:${esc(s.color)}">${icon(s.icon, 15)}<strong>${esc(s.name)}</strong></span>` },
          { key: 'code', header: 'Código' },
          { header: 'Suma a', render: (s) => [
            s.counts_ready && 'Listas', s.counts_cleaning && 'Limpieza', s.counts_maintenance && 'Mantenimiento',
            s.counts_blocked && 'Bloqueadas', s.counts_pending && 'Pendientes', s.counts_attention && 'Atención',
          ].filter(Boolean).map((x) => `<span class="chip tiny">${x}</span>`).join(' ') || '<span class="muted tiny">—</span>' },
          { header: 'Activo', render: (s) => activeChip(s.active) }],
        fields: () => [
          { name: 'code', label: 'Código', required: true, placeholder: 'EN_DESINFECCION' },
          { name: 'name', label: 'Nombre visible', required: true },
          { name: 'icon', label: 'Icono', type: 'select', options: ['check-circle', 'user', 'door', 'spray', 'sparkles',
            'clipboard', 'shield-check', 'wrench', 'tool', 'ban', 'lock', 'alert', 'clock'].map((i) => ({ value: i, label: i })) },
          { name: 'color', label: 'Color', type: 'text', placeholder: '#16a34a' },
          { name: 'counts_ready', label: 'Cuenta como habitación lista', type: 'checkbox' },
          { name: 'counts_cleaning', label: 'Cuenta como en limpieza', type: 'checkbox' },
          { name: 'counts_maintenance', label: 'Cuenta como mantenimiento', type: 'checkbox' },
          { name: 'counts_blocked', label: 'Cuenta como bloqueada', type: 'checkbox' },
          { name: 'counts_pending', label: 'Cuenta como pendiente', type: 'checkbox' },
          { name: 'counts_attention', label: 'Aparece en "Requiere atención"', type: 'checkbox' },
          { name: 'sort_order', label: 'Orden', type: 'number' },
          { name: 'active', label: 'Activo', type: 'checkbox', default: true },
        ],
        afterChange: loadBootstrap,
      });
    }

    if (id === 'categories') {
      return catalogTab(box, {
        path: 'categories', title: 'Categorías', newLabel: 'Nueva categoría', entityName: 'Categoría',
        subtitle: 'El departamento asignado define quién puede escribir en la categoría.',
        columns: [{ key: 'name', header: 'Categoría' }, { key: 'code', header: 'Código' },
          { header: 'Departamento', render: (c) => esc(state.departments.find((d) => d.id === c.department_id)?.name ?? 'General (todos)') },
          { key: 'sort_order', header: 'Orden' }, { header: 'Activa', render: (c) => activeChip(c.active) }],
        fields: () => [
          { name: 'code', label: 'Código', required: true },
          { name: 'name', label: 'Nombre', required: true },
          { name: 'department_id', label: 'Departamento responsable', type: 'select', allowEmpty: true,
            options: state.departments.map((d) => ({ value: d.id, label: d.name })),
            hint: 'Sin departamento: cualquier rol con permiso puede escribir.' },
          { name: 'icon', label: 'Icono', type: 'select',
            options: ['spray', 'wrench', 'wifi', 'folder', 'shield', 'clipboard'].map((i) => ({ value: i, label: i })) },
          { name: 'color', label: 'Color' },
          { name: 'sort_order', label: 'Orden', type: 'number' },
          { name: 'active', label: 'Activa', type: 'checkbox', default: true },
        ],
        afterChange: loadBootstrap,
      });
    }

    if (id === 'fields') {
      return catalogTab(box, {
        path: 'fields', title: 'Campos por categoría', newLabel: 'Nuevo campo', entityName: 'Campo',
        subtitle: 'Los valores de incidencia disparan la alerta y la reincidencia automáticamente.',
        columns: [{ key: 'label', header: 'Campo' }, { key: 'category_name', header: 'Categoría' },
          { key: 'type', header: 'Tipo' },
          { header: 'Opciones', render: (f) => {
            try { return (JSON.parse(f.options ?? '[]')).map((o) => `<span class="chip tiny">${esc(o)}</span>`).join(' ') || '—'; }
            catch { return '—'; } } },
          { header: 'Incidencia si', render: (f) => {
            try { return (JSON.parse(f.is_incident_when ?? '[]')).map((o) => `<span class="chip danger tiny">${esc(o)}</span>`).join(' ') || '—'; }
            catch { return '—'; } } },
          { header: 'Activo', render: (f) => activeChip(f.active) }],
        fields: (f) => [
          { name: 'category_id', label: 'Categoría', type: 'select', required: true,
            options: state.categories.map((c) => ({ value: c.id, label: c.name })) },
          { name: 'code', label: 'Código', required: true, placeholder: 'cortinas' },
          { name: 'label', label: 'Etiqueta visible', required: true },
          { name: 'type', label: 'Tipo', type: 'select',
            options: ['select', 'text', 'textarea', 'number', 'date'].map((t) => ({ value: t, label: t })) },
          { name: 'options', label: 'Opciones (separadas por coma)',
            default: f ? (() => { try { return JSON.parse(f.options ?? '[]').join(', '); } catch { return ''; } })() : '',
            hint: 'Sólo para tipo "select".' },
          { name: 'is_incident_when', label: 'Valores que abren incidencia (separados por coma)',
            default: f ? (() => { try { return JSON.parse(f.is_incident_when ?? '[]').join(', '); } catch { return ''; } })() : '' },
          { name: 'default_value', label: 'Valor por defecto' },
          { name: 'sort_order', label: 'Orden', type: 'number' },
          { name: 'active', label: 'Activo', type: 'checkbox', default: true },
        ],
        // El formulario captura listas separadas por coma; la API espera arreglos.
        transform: (v) => ({
          ...v,
          options: toList(v.options),
          is_incident_when: toList(v.is_incident_when),
        }),
        afterChange: loadBootstrap,
      });
    }

    if (id === 'actions') {
      return catalogTab(box, {
        path: 'movement-types', title: 'Acciones y tipos de movimiento',
        newLabel: 'Nueva acción', entityName: 'Acción',
        subtitle: 'Definen las acciones rápidas y el estado al que llevan la habitación.',
        columns: [{ key: 'name', header: 'Acción' }, { key: 'code', header: 'Código' },
          { key: 'severity', header: 'Severidad' },
          { header: 'Incidencia', render: (a) => yes(a.is_incident) },
          { header: 'Pide comentario', render: (a) => yes(a.requires_comment) },
          { header: 'Rápida', render: (a) => yes(a.is_quick_action) },
          { header: 'Activa', render: (a) => activeChip(a.active) }],
        fields: () => [
          { name: 'code', label: 'Código', required: true },
          { name: 'name', label: 'Nombre', required: true },
          { name: 'category_id', label: 'Categoría', type: 'select', allowEmpty: true,
            options: state.categories.map((c) => ({ value: c.id, label: c.name })) },
          { name: 'target_status_id', label: 'Estado destino', type: 'select', allowEmpty: true,
            options: state.statuses.map((s) => ({ value: s.id, label: s.name })),
            hint: 'Déjelo vacío si la acción no cambia el estado.' },
          { name: 'severity', label: 'Severidad', type: 'select',
            options: [{ value: 'normal', label: 'Normal' }, { value: 'alta', label: 'Alta' }, { value: 'critica', label: 'Crítica' }] },
          { name: 'is_incident', label: 'Abre incidencia', type: 'checkbox' },
          { name: 'closes_incident', label: 'Cierra incidencia', type: 'checkbox' },
          { name: 'requires_comment', label: 'Exige comentario', type: 'checkbox' },
          { name: 'requires_photo', label: 'Exige fotografía', type: 'checkbox' },
          { name: 'is_quick_action', label: 'Mostrar como acción rápida', type: 'checkbox', default: true },
          { name: 'notify', label: 'Genera notificación', type: 'checkbox' },
          { name: 'sort_order', label: 'Orden', type: 'number' },
          { name: 'active', label: 'Activa', type: 'checkbox', default: true },
        ],
        afterChange: async () => { resetQuickActions(); await loadBootstrap(); },
      });
    }

    if (id === 'departments') {
      return catalogTab(box, {
        path: 'departments', title: 'Departamentos', newLabel: 'Nuevo departamento', entityName: 'Departamento',
        subtitle: 'Los departamentos delimitan qué categorías puede editar cada rol.',
        columns: [{ key: 'name', header: 'Departamento' }, { key: 'code', header: 'Código' },
          { key: 'sort_order', header: 'Orden' }, { header: 'Activo', render: (d) => activeChip(d.active) }],
        fields: () => [
          { name: 'code', label: 'Código', required: true },
          { name: 'name', label: 'Nombre', required: true },
          { name: 'color', label: 'Color' },
          { name: 'sort_order', label: 'Orden', type: 'number' },
          { name: 'active', label: 'Activo', type: 'checkbox', default: true },
        ],
        afterChange: loadBootstrap,
      });
    }
    return undefined;
  };

  $$('[data-tab]', outlet).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  await show(tabs[0].id);
}
