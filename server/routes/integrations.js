import express from 'express';
import { requireAuth, asyncRoute } from '../middleware/auth.js';

const router = express.Router();

/**
 * Punto de extensión para integraciones futuras.
 * La estructura queda lista (contrato, versionado y descubrimiento) pero
 * ninguna integración está implementada todavía: cada una responde 501.
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

router.get('/', requireAuth, asyncRoute((req, res) => {
  res.json({
    version: 'v1',
    status: 'preparado',
    note: 'Estructura lista para integraciones. Ninguna está habilitada todavía.',
    integrations: INTEGRATIONS.map((i) => ({
      ...i,
      enabled: false,
      inbound: `/api/integrations/${i.code}/events`,
      outbound: `/api/integrations/${i.code}/sync`,
    })),
  });
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
