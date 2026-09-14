// ============================================================================
// Opera un par de habitaciones con la versión ANTERIOR del CDH, para que la
// puesta al día se ejecute sobre una base con historial de verdad. Imprime
// cuántos movimientos quedaron: el paso siguiente comprueba que no cambien.
//
// Va en un archivo y no dentro de `node -e "..."`: ahí cada comilla y cada
// acento grave hay que escaparlos, y un descuido no rompe la sintaxis —el
// shell ejecuta el resto como si fueran comandos— sino el trabajo entero, con
// un error que no se parece en nada a su causa. Ya pasó una vez.
//
// Los módulos se cargan desde el DIRECTORIO DE TRABAJO, no desde la ruta de
// este archivo: el CDH que se opera aquí es el de la copia vieja.
// ============================================================================
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cargar = (rel) => import(pathToFileURL(path.resolve(rel)).href);

const { one, all } = await cargar('server/lib/db.js');
const { loadSettings } = await cargar('server/lib/settings.js');
loadSettings();
const { withPermissions, findUserByUsername } = await cargar('server/lib/auth.js');
const { recordMovement, getRoomByNumber } = await cargar('server/lib/movements.js');

const u = withPermissions(findUserByUsername('supervisor'));
// Se opera con estados tomados del catálogo de ESA versión: una acción
// nombrada a mano deja de existir a la vuelta siguiente y rompe el montaje de
// la prueba, no lo que se quiere probar.
const estados = all('SELECT code FROM room_statuses WHERE active = 1 ORDER BY sort_order');
for (const numero of ['401', '402']) {
  const hab = getRoomByNumber(numero);
  const destino = estados.find((e) => e.code !== hab.status_code);
  recordMovement({
    roomId: hab.id, user: u, statusCode: destino.code,
    comment: 'Operación registrada antes de actualizar.',
  });
}
process.stdout.write(String(one('SELECT COUNT(*) n FROM movements').n));
