import express from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { all, one } from '../lib/db.js';
import { requireAuth, requirePermission, asyncRoute } from '../middleware/auth.js';
import { periodRange, stamp, getTimezone } from '../lib/time.js';
import { overview, statusBreakdown, problemsByFloor, problemsByDepartment, recurrence, thresholds } from '../lib/stats.js';
import { getSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';

const router = express.Router();
router.use(requireAuth, requirePermission('report.view'));

const int = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/** Traduce los filtros de la petición a una cláusula WHERE sobre movements. */
function buildFilters(query) {
  const range = query.from && query.to
    ? { from: query.from, to: query.to }
    : periodRange(query.period ?? 'mes');
  const where = ['m.local_date BETWEEN @from AND @to'];
  const params = { from: range.from, to: range.to };

  if (query.floorId)      { where.push('m.floor_id = @floorId');           params.floorId = int(query.floorId); }
  if (query.roomId)       { where.push('m.room_id = @roomId');             params.roomId = int(query.roomId); }
  if (query.roomNumber)   { where.push('m.room_number = @roomNumber');     params.roomNumber = String(query.roomNumber); }
  if (query.departmentId) { where.push('m.department_id = @departmentId'); params.departmentId = int(query.departmentId); }
  if (query.userId)       { where.push('m.user_id = @userId');             params.userId = int(query.userId); }
  if (query.categoryId)   { where.push('m.category_id = @categoryId');     params.categoryId = int(query.categoryId); }
  if (query.actionCode)   { where.push('m.action_code = @actionCode');     params.actionCode = String(query.actionCode); }
  if (query.statusCode)   { where.push('m.new_status_name = (SELECT name FROM room_statuses WHERE code = @statusCode)'); params.statusCode = String(query.statusCode); }
  if (query.incidentsOnly === 'true') where.push('m.is_incident = 1');
  if (query.severity)     { where.push('m.severity = @severity');          params.severity = String(query.severity); }

  return { range, where: where.join(' AND '), params };
}

const COLUMNS = [
  { key: 'id',              header: 'ID',              width: 8 },
  { key: 'local_date',      header: 'Fecha',           width: 12 },
  { key: 'local_time',      header: 'Hora',            width: 10 },
  { key: 'room_number',     header: 'Habitación',      width: 12 },
  { key: 'floor_number',    header: 'Piso',            width: 8 },
  { key: 'department_name', header: 'Departamento',    width: 18 },
  { key: 'user_name',       header: 'Usuario',         width: 22 },
  { key: 'category_name',   header: 'Categoría',       width: 18 },
  { key: 'action',          header: 'Acción',          width: 26 },
  { key: 'field_label',     header: 'Campo modificado',width: 20 },
  { key: 'old_value',       header: 'Valor anterior',  width: 20 },
  { key: 'new_value',       header: 'Valor nuevo',     width: 20 },
  { key: 'old_status_name', header: 'Estado anterior', width: 20 },
  { key: 'new_status_name', header: 'Estado nuevo',    width: 20 },
  { key: 'guest_present',   header: '¿Huésped presente?', width: 18 },
  { key: 'severity',        header: 'Severidad',       width: 12 },
  { key: 'incidencia',      header: 'Incidencia',      width: 12 },
  { key: 'comment',         header: 'Comentario',      width: 44 },
  { key: 'photo_count',     header: 'Fotos',           width: 8 },
  { key: 'created_at',      header: 'Timestamp (UTC)', width: 24 },
];

function fetchRows(query, limit = 20000) {
  const { range, where, params } = buildFilters(query);
  const rows = all(`
    SELECT m.* FROM movements m WHERE ${where}
     ORDER BY m.created_epoch DESC, m.id DESC LIMIT ${limit}`, params);
  return { range, rows: rows.map((r) => ({ ...r, incidencia: r.is_incident ? 'Sí' : 'No' })) };
}

function reportTitle(query, range) {
  const period = query.period ?? (query.from ? 'personalizado' : 'mes');
  const label = { hoy: 'Reporte diario', semana: 'Reporte semanal', mes: 'Reporte mensual' }[period]
    ?? 'Reporte de movimientos';
  return `${label} — ${range.from} a ${range.to}`;
}

// ---------------------------------------------------------------- Consulta
router.get('/movements', asyncRoute((req, res) => {
  const { range, where, params } = buildFilters(req.query);
  const limit = Math.min(Number(req.query.limit ?? 100), 1000);
  const offset = Number(req.query.offset ?? 0);
  res.json({
    range,
    total: one(`SELECT COUNT(*) AS n FROM movements m WHERE ${where}`, params).n,
    incidents: one(`SELECT COUNT(*) AS n FROM movements m WHERE ${where} AND m.is_incident = 1`, params).n,
    columns: COLUMNS.map(({ key, header }) => ({ key, header })),
    items: all(`SELECT m.* FROM movements m WHERE ${where}
                 ORDER BY m.created_epoch DESC, m.id DESC LIMIT ${limit} OFFSET ${offset}`, params),
  });
}));

/** Resumen ejecutivo del periodo: base de los reportes diario/semanal/mensual. */
router.get('/summary', asyncRoute((req, res) => {
  const { range, where, params } = buildFilters(req.query);
  res.json({
    range,
    overview: overview(),
    statuses: statusBreakdown(),
    floors: problemsByFloor(),
    departments: problemsByDepartment(range),
    recurrence: recurrence({ ...range, minCount: thresholds()[0] ?? 2 }),
    byDay: all(`
      SELECT m.local_date AS fecha, COUNT(*) AS movimientos, SUM(m.is_incident) AS incidencias
        FROM movements m WHERE ${where} GROUP BY m.local_date ORDER BY m.local_date`, params),
    byAction: all(`
      SELECT m.action, m.action_code, COUNT(*) AS total, SUM(m.is_incident) AS incidencias
        FROM movements m WHERE ${where} GROUP BY m.action_code ORDER BY total DESC`, params),
    byCategory: all(`
      SELECT COALESCE(m.category_name,'Sin categoría') AS categoria, COUNT(*) AS total,
             SUM(m.is_incident) AS incidencias
        FROM movements m WHERE ${where} GROUP BY m.category_id ORDER BY total DESC`, params),
  });
}));

// ---------------------------------------------------------------- Exportar
const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/export', requirePermission('report.export'), asyncRoute(async (req, res) => {
  const format = String(req.query.format ?? 'csv').toLowerCase();
  const { range, rows } = fetchRows(req.query);
  const hotel = getSetting('hotel_name', 'Hotel Quartz');
  const title = reportTitle(req.query, range);
  const t = stamp();
  const base = `CDH_movimientos_${range.from}_${range.to}`;

  audit({
    entityType: 'report', entityId: format, entityLabel: title, action: 'export',
    actor: req.user, after: { formato: format, filas: rows.length, rango: range },
    reason: 'Exportación de reporte.', req,
  });

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    // BOM para que Excel reconozca los acentos.
    res.write('﻿');
    res.write(`${COLUMNS.map((c) => esc(c.header)).join(',')}\n`);
    for (const r of rows) res.write(`${COLUMNS.map((c) => esc(r[c.key])).join(',')}\n`);
    return res.end();
  }

  if (format === 'xlsx' || format === 'excel') {
    const wb = new ExcelJS.Workbook();
    wb.creator = `${hotel} — CDH`;
    wb.created = new Date();

    const ws = wb.addWorksheet('Movimientos', { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.mergeCells('A1:S1');
    ws.getCell('A1').value = `${hotel} — ${title}`;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.mergeCells('A2:S2');
    ws.getCell('A2').value = `Generado ${t.localDate} ${t.localTime} (${getTimezone()}) por ${req.user.full_name} — ${rows.length} movimientos`;
    ws.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } };

    ws.getRow(3).values = COLUMNS.map((c) => c.header);
    ws.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6B2E63' } };
    ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));
    for (const r of rows) ws.addRow(COLUMNS.map((c) => r[c.key] ?? ''));
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: COLUMNS.length } };

    const resumen = wb.addWorksheet('Resumen');
    const ov = overview();
    resumen.columns = [{ width: 34 }, { width: 16 }];
    resumen.addRow([`${hotel} — Resumen del periodo`]).font = { bold: true, size: 13 };
    resumen.addRow([`${range.from} a ${range.to}`]);
    resumen.addRow([]);
    for (const [k, v] of [
      ['Total de habitaciones', ov.total], ['Listas', ov.listas], ['En limpieza', ov.limpieza],
      ['Mantenimiento', ov.mantenimiento], ['Bloqueadas', ov.bloqueadas], ['Pendientes', ov.pendientes],
      ['Incidencias abiertas', ov.incidenciasAbiertas], ['Movimientos del día', ov.movimientosHoy],
      ['Movimientos del periodo', rows.length],
    ]) resumen.addRow([k, v]);
    resumen.addRow([]);
    resumen.addRow(['Departamento', 'Movimientos', 'Incidencias']).font = { bold: true };
    for (const d of problemsByDepartment(range)) resumen.addRow([d.departamento, d.movimientos, d.incidencias]);
    resumen.addRow([]);
    resumen.addRow(['Habitación', 'Piso', 'Incidencias (reincidencia)']).font = { bold: true };
    for (const r of recurrence({ ...range, minCount: thresholds()[0] ?? 2 }).rooms.slice(0, 40)) {
      resumen.addRow([r.room_number, r.floor_number, r.incidents]);
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }

  if (format === 'pdf') {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 28 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
    doc.pipe(res);

    const cols = [
      { key: 'local_date', header: 'Fecha', w: 58 },
      { key: 'local_time', header: 'Hora', w: 48 },
      { key: 'room_number', header: 'Hab.', w: 42 },
      { key: 'department_name', header: 'Depto.', w: 78 },
      { key: 'user_name', header: 'Usuario', w: 92 },
      { key: 'action', header: 'Acción', w: 108 },
      { key: 'field_label', header: 'Campo', w: 76 },
      { key: 'old_value', header: 'Antes', w: 76 },
      { key: 'new_value', header: 'Después', w: 76 },
      { key: 'comment', header: 'Comentario', w: 102 },
    ];
    const startX = doc.page.margins.left;
    const bottom = doc.page.height - doc.page.margins.bottom - 22;

    const header = () => {
      doc.fontSize(14).fillColor('#6b2e63').text(`${hotel} — CDH`, startX, 28);
      doc.fontSize(10).fillColor('#334155').text(title, startX, 46);
      doc.fontSize(8).fillColor('#64748b')
        .text(`Generado ${t.localDate} ${t.localTime} (${getTimezone()}) por ${req.user.full_name} · ${rows.length} movimientos`, startX, 60);
      let x = startX; const y = 78;
      doc.rect(startX, y - 4, cols.reduce((s, c) => s + c.w, 0), 16).fill('#6b2e63');
      doc.fontSize(7.5).fillColor('#ffffff');
      for (const c of cols) { doc.text(c.header, x + 3, y, { width: c.w - 6, ellipsis: true }); x += c.w; }
      doc.fillColor('#0f172a');
      return y + 16;
    };

    let y = header();
    let zebra = false;
    for (const r of rows) {
      if (y > bottom) { doc.addPage(); y = header(); zebra = false; }
      if (zebra) doc.rect(startX, y - 2, cols.reduce((s, c) => s + c.w, 0), 14).fill('#f1f5f9');
      zebra = !zebra;
      let x = startX;
      doc.fontSize(7).fillColor(r.is_incident ? '#b91c1c' : '#0f172a');
      for (const c of cols) {
        doc.text(r[c.key] === null || r[c.key] === undefined ? '' : String(r[c.key]),
          x + 3, y, { width: c.w - 6, height: 11, ellipsis: true, lineBreak: false });
        x += c.w;
      }
      y += 14;
    }
    if (!rows.length) doc.fontSize(10).fillColor('#64748b').text('Sin movimientos en el periodo seleccionado.', startX, y + 10);

    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i += 1) {
      doc.switchToPage(pages.start + i);
      doc.fontSize(7).fillColor('#94a3b8').text(
        `CDH — Control de Detalles por Habitación · Página ${i + 1} de ${pages.count}`,
        startX, doc.page.height - doc.page.margins.bottom - 10,
        { width: doc.page.width - startX * 2, align: 'center' });
    }
    doc.end();
    return undefined;
  }

  return res.status(400).json({ error: `Formato no soportado: ${format}. Use csv, xlsx o pdf.` });
}));

export default router;
