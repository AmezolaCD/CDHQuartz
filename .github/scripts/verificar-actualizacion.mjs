// ============================================================================
// Invariantes que tienen que valer DESPUÉS de poner al día una base en uso.
//
// Se comprueban con el código NUEVO sobre la base que operó el anterior. Todo
// lo que se mira aquí vale para cualquier versión: atarlo a algo de UNA —una
// columna, un código de acción— envejece y da un rojo falso a la siguiente.
// Ya pasó dos veces.
//
// Los módulos se cargan desde el directorio de trabajo, igual que en
// `operar-antes.mjs`, y por la misma razón.
// ============================================================================
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cargar = (rel) => import(pathToFileURL(path.resolve(rel)).href);

const { one, all } = await cargar('server/lib/db.js');
const { loadSettings } = await cargar('server/lib/settings.js');
loadSettings();
const { withPermissions, findUserByUsername } = await cargar('server/lib/auth.js');
const { recordMovement, getRoomByNumber } = await cargar('server/lib/movements.js');
const { MOVEMENT_TYPES } = await cargar('server/db/catalog.js');

const fallo = (m) => { console.error('::error::' + m); process.exit(1); };

// 1) El historial es inmutable: la puesta al día no lo toca.
if (one('SELECT COUNT(*) n FROM movements').n !== Number(process.env.ANTES)) {
  fallo('el historial cambió durante la puesta al día');
}

// 2) Ninguna habitación puede quedarse en un estado que se retiró.
const huerfanas = one(`
  SELECT COUNT(*) AS n FROM rooms r
    JOIN room_statuses s ON s.id = r.status_id
   WHERE r.active = 1 AND s.active = 0`).n;
if (huerfanas) fallo(huerfanas + ' habitaciones quedaron en un estado retirado');

// 3) Una bandera nueva sobre una acción que YA existía no llega sola: la
// puesta al día sólo inserta los tipos que faltan. La base de CI se acaba de
// sembrar, así que nadie la ha configurado y toda diferencia con el catálogo
// es un relleno de columna olvidado.
const BANDERAS = ['is_incident', 'closes_incident', 'requires_comment', 'requires_photo',
  'cross_department', 'notify', 'target_from_clean', 'asks_guest_present',
  'closes_cleaning_request', 'warns_pms'];
for (const tipo of MOVEMENT_TYPES) {
  const fila = one('SELECT * FROM movement_types WHERE code = @code', { code: tipo.code });
  if (!fila) fallo('falta el tipo de movimiento ' + tipo.code);
  for (const bandera of BANDERAS) {
    const esperado = Number(tipo[bandera] ?? 0);
    if (Number(fila[bandera]) !== esperado) {
      fallo(tipo.code + '.' + bandera + ' quedó en ' + fila[bandera] +
        ' y el catálogo dice ' + esperado + ': falta el relleno de esa columna en COLUMNAS_NUEVAS');
    }
  }
}

// 4) Nada vigente puede apuntar a un estado retirado: una acción así no
// funciona —el CDH se niega con «Estado desconocido o inactivo»— y deja al
// área sin poder reportar ni cerrar su trabajo. Retirar un estado obliga a
// llevarse consigo lo que apuntaba a él.
const colgando = all(`
  SELECT 'acción ' || m.name AS que, s.name AS estado
    FROM movement_types m JOIN room_statuses s ON s.id = m.target_status_id
   WHERE m.active = 1 AND s.active = 0
   UNION ALL
  SELECT 'categoría ' || c.name, s.name
    FROM categories c JOIN room_statuses s ON s.id = c.pending_status_id
   WHERE c.active = 1 AND s.active = 0`);
for (const x of colgando) {
  console.error('::error::' + x.que + ' sigue apuntando al estado retirado ' + x.estado);
}
if (colgando.length) fallo(colgando.length + ' referencias quedaron en un estado retirado');

// 5) Y la operación sigue viva: un cambio de estado a un estado vigente,
// elegido del catálogo, para no nombrar un código que mañana puede no existir.
const destino = one(`
  SELECT code FROM room_statuses
   WHERE active = 1 AND code <> (SELECT s.code FROM rooms r
     JOIN room_statuses s ON s.id = r.status_id WHERE r.number = '403')
   ORDER BY sort_order LIMIT 1`);
const sup = withPermissions(findUserByUsername('supervisor'));
const r = recordMovement({
  roomId: getRoomByNumber('403').id, user: sup,
  statusCode: destino.code, comment: 'Prueba de operación tras actualizar.',
});
console.log('403 tras actualizar:', r.room.status_name);
if (!r.statusChanged) fallo('la operación no funciona tras actualizar');
