import express from 'express';
import crypto from 'node:crypto';
import { requireAuth, asyncRoute } from '../middleware/auth.js';
import { one, update, transaction } from '../lib/db.js';
import { stamp } from '../lib/time.js';
import { audit } from '../lib/audit.js';
import { getSettingBool } from '../lib/settings.js';
import { findUserByUsername, withPermissions } from '../lib/auth.js';
import { getRoomByNumber, recordMovement, MovementError } from '../lib/movements.js';
import { openIncidentsForRoom } from '../lib/stats.js';
import {
  PMS_MOVEMENT_TYPE, roomNumberFromKey, decidePrecedence, isStalePmsEvent, pmsComment,
  pmsEventKey, isDuplicatePmsEvent, epochFromPmsTimestamp, pmsEventInstant,
} from '../lib/pms.js';

const router = express.Router();

/**
 * Punto de extensión para integraciones futuras.
 * La estructura queda lista (contrato, versionado y descubrimiento); de las
 * integraciones, sólo la del PMS está implementada. El resto responde 501.
 */
const INTEGRATIONS = [
  { code: 'pms',        name: 'PMS',                 scope: 'Ocupación, llegadas, salidas y bloqueos comerciales.' },
  { code: 'housekeeping',name: 'Ama de Llaves',      scope: 'Asignación de camaristas y avance de limpieza.' },
  { code: 'maintenance',name: 'Mantenimiento',       scope: 'Órdenes de trabajo y refacciones.' },
  { code: 'systems',    name: 'Sistemas',            scope: 'Inventario y estado de equipos en habitación.' },
  { code: 'wifi',       name: 'WiFi',                scope: 'Estado del punto de acceso por habitación.' },
  { code: 'telephony',  name: 'Telefonía',           scope: 'Estado de extensión y llamadas de servicio.' },
  { code: 'tv',         name: 'TV / Cast',           scope: 'Estado del decodificador y del casting.' },
  { code: 'locks',      name: 'Cerraduras',          scope: 'Eventos de apertura, batería y bloqueo.' },
  { code: 'iot',        name: 'IoT y sensores',      scope: 'Clima, humedad, fugas y ocupación.' },
];

/** El usuario con el que firma el PMS lo que escribe (ver SERVICE_USERS). */
const PMS_USERNAME = 'arpon';

/**
 * El secreto vive en el entorno, NO en `settings`: `allSettings()` devuelve la
 * tabla entera y la pantalla de administración la expone a cualquiera con
 * `admin.settings`. En settings queda sólo el interruptor, para poder apagar
 * la entrada sin volver a desplegar.
 */
const tokenConfigurado = () => process.env.CDH_PMS_TOKEN ?? '';

const entradaEncendida = () => getSettingBool('pms_inbound_enabled', false);

/**
 * El instante del aviso, sólo si avanza sobre el último que ya se procesó.
 * Devuelve null cuando no hay nada que actualizar, para no escribir de más en
 * cada reintento.
 */
function instanteSiAvanza(room, changedAt) {
  const instante = pmsEventInstant(changedAt);
  if (!instante) return null;
  const previo = room.pms_event_at ? Date.parse(room.pms_event_at) : NaN;
  if (Number.isFinite(previo) && Date.parse(instante) <= previo) return null;
  return instante;
}

/** Compara en tiempo constante y sin delatar el largo, igual que el SSO. */
function mismoToken(enviado) {
  const a = crypto.createHash('sha256').update(String(enviado ?? ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(tokenConfigurado(), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

router.get('/', requireAuth, asyncRoute((req, res) => {
  const pmsLista = !!tokenConfigurado() && entradaEncendida();
  res.json({
    version: 'v1',
    status: 'preparado',
    note: 'Estructura lista para integraciones. Sólo la del PMS está habilitada.',
    integrations: INTEGRATIONS.map((i) => ({
      ...i,
      enabled: i.code === 'pms' ? pmsLista : false,
      inbound: `/api/integrations/${i.code}/events`,
      outbound: `/api/integrations/${i.code}/sync`,
    })),
  });
}));

// ============================================================================
// ENTRADA DEL PMS — Arpón avisa, el CDH sigue.
//
// Va declarada ANTES del comodín de abajo: Express resuelve por orden y el
// comodín respondería 501 a esta misma ruta.
//
// No usa `requireAuth`, que es por cookie: Arpón no trae cookie, se autentica
// con un token fijo en una cabecera. `attachUser` ya corrió y dejó
// `req.user = null`; el actor se arma leyendo la identidad de servicio.
//
// Los códigos están pensados para un webhook CON REINTENTOS, no para una
// pantalla: sólo lo que vale la pena reintentar sale 5xx. Una condición
// permanente —una habitación que aquí no existe— responde 200 diciendo que no
// se aplicó, porque un 404 haría a Arpón reintentar para siempre.
// ============================================================================
router.post('/pms/events', asyncRoute((req, res) => {
  // Sin secreto no hay forma de autenticar a nadie, y es un despliegue a medio
  // configurar: se dice con claridad en vez de rechazar como si fuera culpa de
  // quien llama.
  if (!tokenConfigurado()) {
    return res.status(503).json({ error: 'La entrada del PMS no está configurada (falta CDH_PMS_TOKEN).' });
  }

  const enviado = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') ?? ''))?.[1] ?? '';
  if (!mismoToken(enviado)) {
    return res.status(401).json({ error: 'No autorizado.' });
  }

  // El interruptor se comprueba DESPUÉS de autenticar: que la ruta exista no
  // es asunto de quien no trae el token.
  if (!entradaEncendida()) {
    return res.status(503).json({ error: 'La entrada del PMS está apagada (pms_inbound_enabled).' });
  }

  // `hotelId` llega en el cuerpo y no se compara contra nada: el CDH sirve a
  // un solo hotel y no guarda el identificador de Arpón. Si algún día sirviera
  // a más de uno, aquí es donde habría que fijarlo.
  const cuerpo = req.body ?? {};
  const mapeo = roomNumberFromKey(cuerpo.roomKey);
  if (!mapeo.ok) {
    return res.status(400).json({
      error: 'roomKey inválido: se esperan tres o cuatro dígitos, por ejemplo "0301" o "301".',
      reason: mapeo.reason,
    });
  }
  const status = typeof cuerpo.status === 'string' ? cuerpo.status.trim() : '';
  if (!status) {
    return res.status(400).json({ error: 'Falta el estado en el evento.', reason: 'sin_estado' });
  }
  const changedAt = typeof cuerpo.changedAt === 'string' ? cuerpo.changedAt : null;
  const changedBy = typeof cuerpo.changedBy === 'string' ? cuerpo.changedBy : null;

  // La identidad de servicio tiene que existir y estar activa: sin autor no se
  // puede registrar nada, y el historial es inmutable. Es configuración
  // nuestra, así que 503 y vale reintentar.
  const encontrado = findUserByUsername(PMS_USERNAME);
  if (!encontrado || !encontrado.active) {
    return res.status(503).json({
      error: `Falta la identidad de servicio "${PMS_USERNAME}" o está desactivada. Ejecute npm run upgrade.`,
    });
  }
  const actor = withPermissions(encontrado);

  const room = getRoomByNumber(mapeo.number);
  if (!room || !room.active) {
    // Permanente: reintentar no la va a hacer aparecer. Queda en la bitácora
    // para que Sistemas vea que Arpón conoce una habitación que aquí no está.
    audit({
      entityType: 'integration', entityLabel: 'pms', action: 'pms_evento_ignorado',
      actor, reason: `Arpón reportó la habitación ${cuerpo.roomKey}, que el CDH no tiene activa.`,
      after: { roomKey: cuerpo.roomKey, status }, req,
    });
    return res.json({ ok: true, applied: false, reason: 'habitacion_desconocida' });
  }

  // Un reintento del webhook repite el cuerpo tal cual. Si el aviso no trae
  // fecha, es lo único que permite distinguirlo de un cambio nuevo: sin esto,
  // un reintento tardío devuelve la habitación a un estado ya superado y deja
  // un movimiento duplicado en un historial que no se puede borrar.
  const clave = pmsEventKey({ roomKey: cuerpo.roomKey, status, changedAt, changedBy });
  if (isDuplicatePmsEvent({
    key: clave,
    lastKey: room.pms_last_event_key,
    lastEpoch: room.pms_last_event_epoch,
    now: stamp().epoch,
    tieneFecha: epochFromPmsTimestamp(changedAt) !== null,
  })) {
    return res.json({ ok: true, applied: false, reason: 'duplicado', room: room.number });
  }

  if (isStalePmsEvent({ changedAt, lastEventAt: room.pms_event_at })) {
    audit({
      entityType: 'integration', entityId: room.id, entityLabel: 'pms',
      action: 'pms_evento_rezagado', actor, roomId: room.id,
      reason: `Arpón reportó "${status}" con fecha anterior al último cambio de la habitación ${room.number}.`,
      after: { roomKey: cuerpo.roomKey, status, changedAt }, req,
    });
    return res.json({ ok: true, applied: false, reason: 'evento_rezagado' });
  }

  // Lo que sostiene a "Fuera de servicio" y a "Discrepancia" es el pendiente
  // abierto, no el nombre del estado: cerrarlo no cambia el estado por sí solo,
  // así que sin esto la habitación dejaría de escuchar al PMS para siempre.
  const pendienteAbierto = openIncidentsForRoom(room.id).length > 0;

  const decision = decidePrecedence({
    currentStatusCode: room.status_code, incomingStatusCode: status, pendienteAbierto,
  });

  // El reintento normal del webhook cae aquí: ni movimiento ni bitácora, que
  // sería ruido en el historial y mentiría a los contadores de reincidencia.
  if (decision.reason === 'sin_cambio') {
    // Arpón volvió a coincidir con el CDH: si había un desacuerdo anotado, se
    // terminó. No deja movimiento —no pasó nada— pero el aviso del rack sí
    // tiene que apagarse.
    const cambios = {};
    if (room.pms_conflict_status) {
      cambios.pms_conflict_status = null;
      cambios.pms_conflict_at = null;
    }
    const instante = instanteSiAvanza(room, changedAt);
    if (instante) cambios.pms_event_at = instante;
    if (Object.keys(cambios).length) {
      // Apagar un aviso que SÍ se registró al encenderse no puede ser la única
      // escritura sobre `rooms` sin rastro: van juntas o no van.
      const huboDesacuerdo = !!room.pms_conflict_status;
      transaction(() => {
        update('rooms', room.id, cambios);
        if (huboDesacuerdo) {
          audit({
            entityType: 'integration', entityId: room.id, entityLabel: 'pms',
            action: 'pms_desacuerdo_resuelto', actor, roomId: room.id,
            reason: `Arpón volvió a coincidir con el CDH en "${room.status_name}".`,
            before: { pms_conflict_status: room.pms_conflict_status },
            after: { pms_conflict_status: null }, req,
          });
        }
      })();
    }
    return res.json({ ok: true, applied: false, reason: 'sin_cambio', room: room.number });
  }

  const entrante = one('SELECT name FROM room_statuses WHERE code = @code', { code: status });
  const comment = pmsComment({
    apply: decision.apply,
    reason: decision.reason,
    incomingLabel: entrante?.name ?? status,
    currentLabel: room.status_name,
    changedBy,
    changedAt,
  });

  try {
    // Pasa por la única puerta de escritura del sistema. Lleva estado cuando se
    // aplica y no lo lleva cuando la regla conservó el del CDH: en los dos
    // casos queda el movimiento, porque el historial cuenta lo que pasó y no
    // sólo lo que cambió.
    // El movimiento y el aviso del rack van juntos o no van: si se registrara
    // el movimiento y fallara la anotación, el desacuerdo quedaría en el
    // historial pero invisible para quien opera.
    const resultado = transaction(() => {
      const r = recordMovement({
        roomId: room.id,
        user: actor,
        req,
        movementTypeCode: PMS_MOVEMENT_TYPE,
        statusCode: decision.apply ? status : null,
        comment,
      });
      const marcas = {};
      // El desacuerdo se anota en la habitación para que salga en "Requiere
      // atención". Cuando el aviso SÍ se aplica no hace falta: `recordMovement`
      // limpia la marca al mover el estado.
      if (decision.reason === 'estado_propio_del_cdh') {
        marcas.pms_conflict_status = status;
        marcas.pms_conflict_at = stamp().iso;
      }
      // Hasta dónde hemos visto avanzar el reloj de Arpón, que es contra lo que
      // se detecta una entrega desordenada. Se guarda aunque el aviso no se
      // haya aplicado: igual nos dijo qué cree el PMS y cuándo.
      const instante = instanteSiAvanza(room, changedAt);
      if (instante) marcas.pms_event_at = instante;
      // La clave del aviso sólo se recuerda si SÍ se aplicó: uno que no se
      // aplicó no dejó nada que un reintento pueda duplicar, y el mismo aviso
      // que ayer perdió contra un pendiente abierto debe poder ganar hoy.
      if (r.statusChanged) {
        marcas.pms_last_event_key = clave;
        marcas.pms_last_event_epoch = stamp().epoch;
      }
      if (Object.keys(marcas).length) update('rooms', room.id, marcas);
      return r;
    })();
    return res.json({
      ok: true,
      applied: resultado.statusChanged,
      reason: decision.reason,
      room: room.number,
      movementId: resultado.primaryId,
    });
  } catch (e) {
    if (!(e instanceof MovementError)) throw e;
    // 403 significa que el rol del PMS está mal configurado: es nuestro
    // problema y vale reintentar cuando se arregle. Lo demás —un estado que no
    // existe o no está activo— es permanente y Arpón tiene que verlo.
    const nuestro = e.status === 403;
    return res.status(nuestro ? 503 : 400).json({ error: e.message, reason: 'rechazado_al_registrar' });
  }
}));

router.all('/:code/{*path}', requireAuth, asyncRoute((req, res) => {
  const integration = INTEGRATIONS.find((i) => i.code === req.params.code);
  if (!integration) return res.status(404).json({ error: `Integración desconocida: ${req.params.code}` });
  res.status(501).json({
    error: `La integración "${integration.name}" aún no está implementada.`,
    integration: integration.code,
    scope: integration.scope,
    contract: {
      note: 'Cuando se habilite, los eventos entrantes generarán movimientos auditables como cualquier otro cambio.',
      expects: { roomNumber: 'string', movementType: 'string', details: '[{fieldCode, value}]', comment: 'string' },
    },
  });
}));

export default router;
