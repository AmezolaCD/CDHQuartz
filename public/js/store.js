import { api } from './api.js';

export const state = {
  user: null,
  hotel: { name: 'Hotel Quartz', app: 'CDH', timezone: '', targetRooms: 155 },
  floors: [], statuses: [], departments: [], categories: [], roomTypes: [], users: [],
  recurrenceThresholds: [2, 3, 5, 10],
  selectedFloorId: null,
  notifications: { total: 0, unread: 0, items: [] },
};

export const can = (...codes) => codes.every((c) => state.user?.permissions?.includes(c));
export const canAny = (...codes) => codes.some((c) => state.user?.permissions?.includes(c));

export const statusByCode = (code) => state.statuses.find((s) => s.code === code) ?? null;
export const floorById = (id) => state.floors.find((f) => f.id === Number(id)) ?? null;

export async function loadSession() {
  try {
    const { user, hotel } = await api.get('api/auth/me');
    state.user = user;
    state.hotel.name = hotel;
    return user;
  } catch { state.user = null; return null; }
}

export async function loadBootstrap() {
  const data = await api.get('api/bootstrap');
  Object.assign(state, {
    hotel: data.hotel,
    floors: data.floors,
    statuses: data.statuses,
    departments: data.departments,
    categories: data.categories,
    roomTypes: data.roomTypes,
    users: data.users,
    recurrenceThresholds: data.recurrenceThresholds,
  });
  if (!state.selectedFloorId && state.floors.length) state.selectedFloorId = state.floors[0].id;
  return data;
}

export async function refreshNotifications() {
  try { state.notifications = await api.get('api/notifications'); }
  catch { /* sin notificaciones disponibles */ }
  return state.notifications;
}

// Suscripción sencilla para que la cabecera reaccione a los cambios.
const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const notifyChange = () => listeners.forEach((fn) => fn());
