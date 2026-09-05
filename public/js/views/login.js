import { api } from '../api.js';
import { $, el, esc, toast } from '../ui.js';
import { icon } from '../icons.js';

export function loginView(onSuccess) {
  const node = el(`
    <div class="login-page">
      <div class="login-card">
        <div data-marca></div>
        <h1>Control de Detalles por Habitación</h1>
        <p class="sub">Expediente digital y auditable de cada habitación.</p>
        <div data-error hidden></div>
        <form id="loginForm" autocomplete="on">
          <div class="field"><label for="u">Usuario</label>
            <input id="u" name="username" autocomplete="username" required autocapitalize="none" spellcheck="false"></div>
          <div class="field"><label for="p">Contraseña</label>
            <input id="p" name="password" type="password" autocomplete="current-password" required></div>
          <button class="btn primary block" type="submit" style="margin-top:6px">Entrar</button>
        </form>
        <p class="tiny muted center" style="margin:18px 0 0">
          Cada acceso y cada cambio quedan registrados en la bitácora de auditoría.
        </p>
      </div>
    </div>`);

  // El logo se consulta antes de iniciar sesión: la pantalla de acceso es lo
  // primero que ve el personal y debe llevar la marca del hotel.
  fetch('/api/bootstrap/logo').then((r) => r.json()).then(({ logo, hotel }) => {
    $('[data-marca]', node).innerHTML = logo
      ? `<img class="login-logo" src="${esc(logo)}" alt="${esc(hotel)}">`
      : `<div class="logo">CDH</div>`;
  }).catch(() => { $('[data-marca]', node).innerHTML = '<div class="logo">CDH</div>'; });

  const errBox = $('[data-error]', node);
  $('#loginForm', node).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('[type=submit]', e.target);
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Verificando…';
    errBox.hidden = true;
    try {
      const fd = new FormData(e.target);
      const { user } = await api.post('/api/auth/login', {
        username: fd.get('username'), password: fd.get('password'),
      });
      await onSuccess(user);
    } catch (err) {
      errBox.innerHTML = `<div class="alert error">${icon('alert', 15)}<span>${esc(err.message)}</span></div>`;
      errBox.hidden = false;
      btn.disabled = false; btn.textContent = 'Entrar';
      $('#p', node).value = '';
      $('#p', node).focus();
    }
  });
  return node;
}

/** Cambio de contraseña obligatorio en el primer acceso. */
export function passwordPrompt(force = false) {
  return new Promise((resolve) => {
    const node = el(`
      <div class="modal-wrap"><div class="modal">
        <header class="modal-head"><h2 style="font-size:16px">Cambiar contraseña</h2>
          ${force ? '<p class="tiny muted" style="margin:3px 0 0">Debe establecer una contraseña propia antes de continuar.</p>' : ''}
        </header>
        <div class="modal-body"><form id="pwForm">
          <div class="field"><label>Contraseña actual</label>
            <input type="password" name="currentPassword" required autocomplete="current-password"></div>
          <div class="field"><label>Nueva contraseña</label>
            <input type="password" name="newPassword" required minlength="8" autocomplete="new-password">
            <span class="hint">Mínimo 8 caracteres.</span></div>
          <div class="field"><label>Confirmar nueva contraseña</label>
            <input type="password" name="confirm" required minlength="8" autocomplete="new-password"></div>
        </form></div>
        <footer class="modal-foot">
          ${force ? '' : '<button class="btn" data-cancel>Cancelar</button>'}
          <button class="btn primary" form="pwForm" type="submit">Guardar</button>
        </footer>
      </div></div>`);

    $('#layer').appendChild(node);
    $('[data-cancel]', node)?.addEventListener('click', () => { node.remove(); resolve(false); });
    $('#pwForm', node).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (fd.get('newPassword') !== fd.get('confirm')) return toast('Las contraseñas no coinciden.', 'error');
      const btn = $('[type=submit]', node);
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        await api.post('/api/auth/password', {
          currentPassword: fd.get('currentPassword'), newPassword: fd.get('newPassword'),
        });
        node.remove(); toast('Contraseña actualizada.'); resolve(true);
      } catch (err) {
        toast(err.message, 'error', 5000);
        btn.disabled = false; btn.textContent = 'Guardar';
      }
      return undefined;
    });
  });
}
