const routes = new Map();
let current = null;
let outlet = null;

export function register(path, view) { routes.set(path, view); }
export function setOutlet(node) { outlet = node; }

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  return {
    path: segments[0] ?? 'inicio',
    params: segments.slice(1),
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
  };
}

export function navigate(path, { replace = false } = {}) {
  const target = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
  if (location.hash === target) return render();
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  return undefined;
}

export async function render() {
  if (!outlet) return;
  const route = parseHash();
  const view = routes.get(route.path) ?? routes.get('inicio');
  current = route;

  // Cada vista registra sus propios manejadores sobre el outlet, que es el
  // mismo nodo en toda la sesión. Vaciar el HTML no los quita: se sustituye
  // el nodo por uno limpio para que no se acumulen entre navegaciones.
  const fresh = outlet.cloneNode(false);
  outlet.replaceWith(fresh);
  outlet = fresh;

  outlet.innerHTML = '<div class="loading"><div class="spinner dark"></div></div>';
  try {
    await view(outlet, route);
  } catch (err) {
    outlet.innerHTML = `<div class="card"><div class="card-body">
      <div class="alert error" style="margin:0">
        <strong>No se pudo cargar la vista.</strong>&nbsp;${err.message ?? err}
      </div></div></div>`;
  }
  window.scrollTo({ top: 0 });
  document.dispatchEvent(new CustomEvent('route:changed', { detail: route }));
}

export const currentRoute = () => current;
window.addEventListener('hashchange', render);
