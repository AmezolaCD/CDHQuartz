// Iconografía en línea: el estado nunca depende sólo del color.
const P = {
  'check-circle':'M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  user:'M16 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M14 7a4 4 0 11-8 0 4 4 0 018 0zM21 21v-2a4 4 0 00-3-3.87',
  door:'M4 21h16M6 21V4a1 1 0 011-1h10a1 1 0 011 1v17M14 12h.01',
  spray:'M9 3h4v4H9zM9 7v14h6V7M7 11h2M5 8h1M5 14h1',
  sparkles:'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3zM19 15l.9 2.3 2.3.9-2.3.9L19 21.4l-.9-2.3-2.3-.9 2.3-.9L19 15z',
  clipboard:'M9 3h6a1 1 0 011 1v1H8V4a1 1 0 011-1zM8 5H6a2 2 0 00-2 2v13a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 12h6M9 16h4',
  'shield-check':'M12 2l8 4v6c0 5-3.4 9.2-8 10-4.6-.8-8-5-8-10V6l8-4zM9 12l2 2 4-4',
  wrench:'M14.7 6.3a4 4 0 01-5 5L4 17v3h3l5.7-5.7a4 4 0 015-5l-2.6-2.6 2.3-2.3a4.5 4.5 0 00-2.7 1.9z',
  tool:'M14.7 6.3a4 4 0 105.3 5.3l-2.6-2.6M9 15l-5 5M12 12l-3 3',
  ban:'M12 21a9 9 0 100-18 9 9 0 000 18zM5.6 5.6l12.8 12.8',
  lock:'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
  unlock:'M5 11h14v10H5zM8 11V7a4 4 0 017.5-2',
  alert:'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  wifi:'M5 12.5a10 10 0 0114 0M8.5 15.8a5.5 5.5 0 017 0M12 19h.01M1.8 9.2a15 15 0 0120.4 0',
  folder:'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  note:'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-6-6zM14 3v6h6M9 13h6M9 17h4',
  camera:'M3 8a2 2 0 012-2h2.5l1.5-2h6l1.5 2H19a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V8zM12 17a4 4 0 100-8 4 4 0 000 8z',
  swap:'M7 4v13M7 4L4 7M7 4l3 3M17 20V7M17 20l3-3M17 20l-3-3',
  edit:'M11 4H5a2 2 0 00-2 2v13a2 2 0 002 2h13a2 2 0 002-2v-6M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
  search:'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  home:'M3 10l9-7 9 7v10a2 2 0 01-2 2H5a2 2 0 01-2-2V10z',
  grid:'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  chart:'M3 3v18h18M8 16V9M13 16V5M18 16v-4',
  bell:'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0',
  settings:'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1A1.7 1.7 0 007 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00-1.2-2.9H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 002.9-1.2V3a2 2 0 114 0v.1A1.7 1.7 0 0017 4.6l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 001.2 2.9H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  history:'M3 3v5h5M3.05 13a9 9 0 105-8.4L3 8M12 7v5l4 2',
  logout:'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  download:'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  chevron:'M9 18l6-6-6-6',
  x:'M18 6L6 18M6 6l12 12',
  filter:'M22 3H2l8 9.5V19l4 2v-8.5L22 3z',
  plus:'M12 5v14M5 12h14',
  users:'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M13 7a4 4 0 11-8 0 4 4 0 018 0zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  shield:'M12 2l8 4v6c0 5-3.4 9.2-8 10-4.6-.8-8-5-8-10V6l8-4z',
  clock:'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  check:'M20 6L9 17l-5-5',
  repeat:'M17 1l4 4-4 4M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 01-4 4H3',
  inbox:'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.1L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.9A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.1z',
  layers:'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
};

export function icon(name, size = 16, extra = '') {
  const d = P[name] ?? P.folder;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra} aria-hidden="true"><path d="${d}"/></svg>`;
}
export const hasIcon = (n) => Object.prototype.hasOwnProperty.call(P, n);
