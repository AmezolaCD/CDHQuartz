# Arquitectura del CDH

## Principio rector

> La complejidad vive en el backend, la base de datos y la auditoría.
> La interfaz se mantiene simple, rápida y sin saturación.

## Capas

```
public/            Interfaz (SPA sin compilación)
  js/views/        Vistas: panel, expediente, pisos, reportes, administración
  js/store.js      Estado compartido y permisos del usuario
server/
  lib/movements.js ← NÚCLEO: la única puerta de escritura operativa
  lib/stats.js     Indicadores, atención y reincidencia
  lib/audit.js     Bitácora inmutable
  lib/time.js      Sello de tiempo del servidor
  routes/          API REST
  db/schema.sql    Esquema + disparadores de inmutabilidad
  db/catalog.js    Catálogo inicial y distribución real del rack
```

## La única puerta de escritura

Todo cambio operativo pasa por `recordMovement()`. No hay ninguna otra ruta
que modifique `rooms` o `room_details`. Esto garantiza que **es imposible
cambiar algo sin dejar historial**.

```
recordMovement()
  ├─ valida permisos y alcance de departamento
  ├─ valida la acción (comentario/foto obligatorios, estado destino válido)
  ├─ calcula los cambios reales (descarta los que no cambian nada)
  │
  └─ TRANSACCIÓN ────────────────────────────────────
       1. movimiento principal (acción y cambio de estado)
       2. un movimiento por cada campo modificado
       3. actualiza rooms y room_details
       4. inserta las fotografías
       5. genera notificación si aplica
       6. escribe la bitácora de auditoría
     ─────────────── todo o nada ────────────────────
```

Los movimientos de un mismo guardado comparten `batch_id`, lo que permite
distinguir un **evento** de las **filas** que generó — la base de un conteo de
reincidencia correcto.

### Cambios en bloque

`recordBulkMovement()` no es una segunda puerta de escritura: llama a
`recordMovement()` una vez por habitación, de modo que cada una conserva su
propio movimiento, su historial y su notificación. Lo que agrega es envolver
las N operaciones en **una sola transacción**: si una falla, ninguna queda
registrada, y el error nombra la habitación que lo provocó. El lote comparte
`bulk_id` en una entrada de auditoría propia, que guarda el estado anterior y
el posterior de cada habitación.

Las habitaciones que ya estaban en el estado destino se **omiten** en vez de
abortar el lote: seleccionar un piso completo y marcar «Limpieza terminada» no
debe fallar porque tres ya lo estuvieran. Las fotografías no viajan en bloque:
son evidencia de una habitación concreta.

## Estado actual vs. historial

| | Tabla | Se modifica | Se borra |
|---|---|---|---|
| Estado actual | `rooms`, `room_details` | Sí | No (baja lógica) |
| Historial | `movements`, `attachments` | **Nunca** | **Nunca** |
| Auditoría | `audit_log` | **Nunca** | **Nunca** |

La inmutabilidad no es una convención del código: son disparadores de SQLite.
Aunque alguien se conecte directamente a la base con la aplicación apagada,
la escritura se rechaza.

## Semántica de estados

Los estados son configurables y no se distinguen sólo por color: cada uno
lleva icono y texto. Las banderas `counts_*` definen a qué indicador del
panel suma cada estado, de modo que agregar un estado nuevo desde
Administración lo integra a los tableros sin tocar código.

`counts_attention` decide si el estado entra en **Requiere atención** y
`attention_weight` qué tan arriba aparece. El indicador del panel y la lista
leen la misma bandera: no pueden contradecirse. Antes la lista nombraba tres
códigos de estado a mano, así que un reporte a Sistemas sumaba en el contador
y nunca aparecía en la lista.

## Los estados son los del PMS

El hotel opera con Arpón. Su pantalla de Ama de Llaves maneja *Disponible
limpio*, *Ocupado sucio*, *Ocupado limpio*, *Salida* y *Entrada nueva*; el CDH
usa esos mismos, con sus mismos nombres, más *Discrepancia* y *Fuera de
servicio*, que Arpón no muestra ahí y la operación necesita. Dos pantallas que
dicen lo mismo no se contradicen, y el día que se enlacen los dos sistemas no
hará falta una tabla de traducción.

`clean_status_id` es el único añadido de forma: dice a dónde pasa cada estado
cuando se termina de limpiarlo. Una habitación *Ocupado sucio* queda *Ocupado
limpio*; una de *Salida* queda *Disponible limpio*. La acción «Limpieza
terminada» no apunta a un estado fijo —se marca con `target_from_clean`— porque
un destino único sería falso en la mitad de los casos.

## El huésped: un dato del reporte

Hubo un momento en que la ocupación fue un segundo eje de la habitación. Dejó
de hacer falta: los estados del PMS ya dicen si hay huésped. Lo que sí hacía
falta, y ningún estado respondía, es **si el huésped estará dentro cuando suba
Mantenimiento o Sistemas**.

Eso es `movements.guest_present` (`si` | `no` | `desconocido`): un dato del
movimiento, no de la habitación. Los tipos de movimiento marcados con
`asks_guest_present` lo exigen, viaja con la notificación al área destino y
queda en el historial. Es información de un instante —la del momento en que se
levantó el reporte— y guardarla como estado permanente la habría hecho mentir
al día siguiente.

Por eso esas acciones no aparecen en el cambio en bloque: la respuesta es de
una habitación concreta, igual que una fotografía.

La tabla `room_occupancies` sigue en el esquema, vacía de filas activas. No se
elimina porque los movimientos ya registrados apuntan a ella y el historial es
inmutable.

## Los reportes y la venta

Un reporte **no mueve el estado**: el estado lo lleva Ama de Llaves y refleja el
ciclo del PMS. Lo que impide vender una habitación es la incidencia abierta, no
un estado especial.

Con una excepción necesaria: si la habitación estaba en un estado de venta
(`counts_ready`) cuando se levanta el reporte de un área que bloquea, sale de la
venta en ese mismo movimiento, al `pending_status_id` de la categoría (*Fuera de
servicio*). Sin ella, el guardián vigilaría la puerta sin expulsar a quien ya
estaba dentro: una habitación ya disponible se quedaría a la venta con el
reporte abierto. Es el mismo patrón con que un campo en falla la retira.

## Incidencias

Una incidencia está **abierta** por cualquiera de dos vías:

1. **Por campo.** El valor actual de un campo coincide con alguno de los
   configurados en `is_incident_when` (*Plomería: Falla*). Se cierra sola al
   corregir el valor: no hay un estado de incidencia que mantener sincronizado.
2. **Por reporte.** Una acción marcada con `is_incident` la levantó —un
   reporte a Mantenimiento o a Sistemas, un daño, un bloqueo— y nada posterior
   la cerró.

Un reporte se cierra de tres maneras, todas ellas un movimiento del historial,
nunca un borrado:

| Cómo | Qué cierra |
|---|---|
| Acción de cierre de su misma área (*Mantenimiento completado*) | Lo pendiente de esa categoría |
| Acción de cierre con `closes_scope = 'habitacion'` (*Liberar habitación*) | Todo lo pendiente de la habitación |
| Un cambio de estado que devuelve la habitación al servicio (`counts_ready`) | Todo lo pendiente de la habitación |

Los movimientos que cambiaron un campo se excluyen del conteo por reporte: el
valor actual del campo ya los representa, y contarlos otra vez sería contarlos
dos veces.

## No se libera con un pendiente abierto

Una habitación no puede pasar a un estado de servicio (`counts_ready`:
*Disponible*, *Inspeccionada*) mientras tenga una incidencia abierta de una
categoría marcada con `blocks_release` —hoy Mantenimiento y Sistemas—, venga
de un reporte o del valor de un campo. La comprobación vive en
`recordMovement()`, la única puerta de escritura, así que vale igual para la
acción rápida, el cambio manual de estado y el cambio en bloque; en un lote,
una sola habitación con pendiente detiene el lote entero.

Lo que **no** bloquea: limpiar, inspeccionar el trabajo de limpieza como paso
intermedio, comentar, adjuntar fotos o reportar. Lo único vedado es devolver
la habitación al servicio. La salida es cerrar el pendiente desde el área
responsable, que es un movimiento del historial como cualquier otro.

Qué categorías bloquean se configura desde Administración: es una casilla de
la categoría, no una lista de códigos en el código.

### El otro lado de la regla: la habitación que ya estaba en servicio

Impedir el paso a un estado de servicio no basta: una habitación **ya
disponible** a la que se le marca *Plomería: Falla* seguiría a la venta, porque
ese guardado no cambia el estado. Por eso, cuando un campo de una categoría que
bloquea pasa a un valor de incidencia y la habitación está en servicio, el
mismo guardado la retira: pasa al `pending_status_id` de esa categoría
(*Mantenimiento pendiente*, *Sistemas pendiente*) y deja un movimiento propio
que lo explica, junto al del campo.

Tres decisiones de esa regla:

- **No exige `room.status`.** Lo provoca el sistema al detectar la falla, no lo
  pide el usuario; quien reporta puede no tener ese permiso, y dejar la
  habitación a la venta sería lo inseguro.
- **Sólo afecta a la que estaba en servicio.** Una habitación en limpieza o en
  mantenimiento sigue su ciclo sin sobresaltos.
- **Pedir a la vez un estado de servicio y reportar la falla se rechaza**, en
  lugar de decidir por el usuario: la petición se contradice a sí misma.

Corregir el campo **no** devuelve sola la habitación al servicio: alguien tiene
que liberarla, que es justo el paso que la regla anterior custodia.

## Extensión sin código

Desde Administración se pueden agregar pisos, habitaciones, estados,
categorías, campos (con sus opciones y valores de incidencia), acciones
rápidas, departamentos, usuarios, roles y permisos. La interfaz se arma a
partir del catálogo, así que un campo nuevo aparece en el expediente y en los
reportes sin desplegar nada.
