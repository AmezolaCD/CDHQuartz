import express from 'express';
import { all, one } from '../lib/db.js';
import { requireAuth, requirePermission, asyncRoute } from '../middleware/auth.js';
import {
  overview, statusBreakdown, problemsByFloor, problemsByDepartment,
  trend, attention, recentActivity, recurrence, thresholds,
} from '../lib/stats.js';
import { periodRange } from '../lib/time.js';
import { getSettingNumber } from '../lib/settings.js';

const router = express.Router();
router.use(requireAuth, requirePermission('room.view'));

const int = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/** Encabezado del dashboard: indicadores + atención + actividad. */
router.get('/', asyncRoute((req, res) => {
  res.json({
    overview: overview(),
    statuses: statusBreakdown(),
    floors: problemsByFloor(),
    attention: attention({ limit: 12 }),
    activity: recentActivity({ limit: getSettingNumber('activity_feed_size', 25) }),
  });
}));

/** Dashboard gerencial: información accionable, sin gráficas innecesarias. */
router.get('/gerencial', requirePermission('dashboard.manage'), asyncRoute((req, res) => {
  const range = req.query.from && req.query.to
    ? { from: req.query.from, to: req.query.to }
    : periodRange(req.query.period ?? 'mes');
  const rec = recurrence({ from: range.from, to: range.to, minCount: thresholds()[0] ?? 2 });

  res.json({
    range,
    overview: overview(),
    statuses: statusBreakdown(),
    floors: problemsByFloor(),
    departments: problemsByDepartment(range),
    recurrence: { ...rec, rooms: rec.rooms.slice(0, 25) },
    trend: trend(14),
    topActions: all(`
      SELECT action, action_code, COUNT(*) AS total, SUM(is_incident) AS incidencias
        FROM movements WHERE local_date BETWEEN @from AND @to
       GROUP BY action_code ORDER BY total DESC LIMIT 10`, range),
    topUsers: all(`
      SELECT user_id, user_name, department_name, COUNT(*) AS movimientos
        FROM movements WHERE local_date BETWEEN @from AND @to
       GROUP BY user_id ORDER BY movimientos DESC LIMIT 10`, range),
  });
}));

/** Dashboard por piso: resumen + mapa (el mapa se sirve en /api/rooms/floors/:id/map). */
router.get('/floor/:id', asyncRoute((req, res) => {
  const floor = one('SELECT * FROM floors WHERE id = @id', { id: int(req.params.id) });
  if (!floor) return res.status(404).json({ error: 'Piso no encontrado.' });
  const summary = problemsByFloor().find((f) => f.id === floor.id) ?? null;
  res.json({
    floor,
    summary,
    statuses: statusBreakdown(floor.id),
    attention: {
      ...attention({ limit: 200 }),
      items: attention({ limit: 200 }).items.filter((i) => i.floor_id === floor.id),
    },
    activity: recentActivity({ limit: 15, filters: { floorId: floor.id } }),
  });
}));

router.get('/attention', asyncRoute((req, res) => {
  res.json(attention({ limit: Math.min(Number(req.query.limit ?? 60), 300) }));
}));

router.get('/activity', requirePermission('history.view'), asyncRoute((req, res) => {
  res.json(recentActivity({
    limit: Math.min(Number(req.query.limit ?? 50), 500),
    offset: Number(req.query.offset ?? 0),
    filters: {
      floorId: int(req.query.floorId),
      roomId: int(req.query.roomId),
      departmentId: int(req.query.departmentId),
      userId: int(req.query.userId),
      categoryId: int(req.query.categoryId),
      incidentsOnly: req.query.incidentsOnly === 'true',
      from: req.query.from, to: req.query.to,
    },
  }));
}));

router.get('/recurrence', asyncRoute((req, res) => {
  const range = req.query.from && req.query.to
    ? { from: req.query.from, to: req.query.to }
    : periodRange(req.query.period ?? 'mes');
  res.json(recurrence({ ...range, minCount: Number(req.query.min ?? thresholds()[0] ?? 2) }));
}));

export default router;
