import { icon } from './icons.js';

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escapa texto para interpolarlo con seguridad dentro de HTML. */
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function toast(message, kind = 'ok', ms = 3600) {
  const box = $('#toasts');
  const node = el(`<div class="toast ${kind}">${icon(
    kind === 'ok' ? 'check' : kind === 'error' ? 'alert' : 'bell', 16)}<span>${esc(message)}</span></div>`);
  box.appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .2s'; setTimeout(() => node.remove(), 220); }, ms);
}

export function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';
}

/** Panel lateral para información secundaria. */
export function drawer({ title, subtitle = '', body, footer = '', width = null, onClose = null }) {
  const layer = $('#layer');
  const overlay = el('<div class="overlay"></div>');
  const panel = el(`
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}"
           ${width ? `style="width:min(${width},100%)"` : ''}>
      <header class="drawer-head">
        <div class="row-between">
          <div class="grow">
            <h2 style="font-size:17px">${title}</h2>
            ${subtitle ? `<p class="muted small" style="margin:2px 0 0">${subtitle}</p>` : ''}
          </div>
          <button class="icon-btn" data-close aria-label="Cerrar">${icon('x', 20)}</button>
        </div>
      </header>
      <div class="drawer-body"></div>
      ${footer ? `<footer class="drawer-foot">${footer}</footer>` : ''}
    </aside>`);

  $('.drawer-body', panel).innerHTML = typeof body === 'string' ? body : '';
  if (body instanceof Node) $('.drawer-body', panel).appendChild(body);

  layer.append(overlay, panel);
  requestAnimationFrame(() => { overlay.classList.add('open'); panel.classList.add('open'); });

  const close = () => {
    overlay.classList.remove('open'); panel.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { overlay.remove(); panel.remove(); onClose?.(); }, 220);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', close);
  panel.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  setTimeout(() => $('input,select,textarea,button:not([data-close])', panel)?.focus(), 240);

  return { panel, body: $('.drawer-body', panel), footer: $('.drawer-foot', panel), close };
}

export function modal({ title, body, footer = '', onClose = null }) {
  const layer = $('#layer');
  const wrap = el(`
    <div class="modal-wrap">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <header class="modal-head"><div class="row-between">
          <h2 style="font-size:16px">${title}</h2>
          <button class="icon-btn" data-close aria-label="Cerrar" style="color:var(--ink-3)">${icon('x', 19)}</button>
        </div></header>
        <div class="modal-body"></div>
        ${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}
      </div>
    </div>`);
  $('.modal-body', wrap).innerHTML = typeof body === 'string' ? body : '';
  if (body instanceof Node) $('.modal-body', wrap).appendChild(body);
  layer.appendChild(wrap);

  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  setTimeout(() => $('input,select,textarea', wrap)?.focus(), 60);
  return { wrap, body: $('.modal-body', wrap), footer: $('.modal-foot', wrap), close };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: `<p style="margin:0;color:var(--ink-2)">${message}</p>`,
      footer: `<button class="btn" data-close>Cancelar</button>
               <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(confirmLabel)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    $('[data-ok]', m.wrap).addEventListener('click', () => { done = true; m.close(); resolve(true); });
  });
}

export function lightbox(src, caption = '') {
  const box = el(`<div class="lightbox"><figure style="margin:0;text-align:center">
      <img src="${esc(src)}" alt="${esc(caption)}">
      ${caption ? `<figcaption style="color:#e2e8f0;margin-top:10px;font-size:12px">${esc(caption)}</figcaption>` : ''}
    </figure></div>`);
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  box.addEventListener('click', close);
  $('#layer').appendChild(box);
}

export const spinner = (dark = true) => `<div class="loading"><div class="spinner ${dark ? 'dark' : ''}"></div></div>`;

export function emptyState(text, iconName = 'inbox') {
  return `<div class="empty">${icon(iconName, 34)}<p>${esc(text)}</p></div>`;
}

/** Etiqueta de estado con icono: nunca depende sólo del color. */
export function statusChip(status, size = 13) {
  return `<span class="chip" style="color:${esc(status.color)};border-color:${esc(status.color)}33;background:${esc(status.color)}12">
    ${icon(status.icon ?? 'circle', size)}${esc(status.name)}</span>`;
}

export function severityChip(severity) {
  const map = { critica: ['danger', 'Crítica'], alta: ['warn', 'Alta'], normal: ['', 'Normal'] };
  const [cls, label] = map[severity] ?? map.normal;
  return `<span class="chip ${cls}">${esc(label)}</span>`;
}

/** "hace 5 min" a partir de un timestamp del servidor. */
export function relative(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d < 30 ? `hace ${d} d` : `hace ${Math.round(d / 30)} meses`;
}

export function fmtDate(date) {
  if (!date) return '—';
  const [y, m, d] = String(date).split('-');
  return `${d}/${m}/${y}`;
}

export function debounce(fn, ms = 260) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Serializa un formulario a objeto plano. */
export function formData(form) {
  return Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
}
