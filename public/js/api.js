// Cliente HTTP del CDH. Toda respuesta de error viene como { error }.
export class ApiError extends Error {
  constructor(message, status, payload) { super(message); this.status = status; this.payload = payload; }
}

async function request(method, path, { body, query, raw = false } = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }

  const res = await fetch(url, init);
  if (raw) {
    if (!res.ok) throw new ApiError('No fue posible generar el archivo.', res.status);
    return res;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? `Error ${res.status}`, res.status, data);
  return data;
}

export const api = {
  get:  (p, query) => request('GET', p, { query }),
  post: (p, body)  => request('POST', p, { body }),
  put:  (p, body)  => request('PUT', p, { body }),
  del:  (p, body)  => request('DELETE', p, { body }),
  raw:  (p, query) => request('GET', p, { query, raw: true }),
};

/** Descarga un archivo generado por el servidor. */
export async function download(path, query, fallbackName) {
  const res = await api.raw(path, query);
  const blob = await res.blob();
  const disp = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disp)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return name;
}
