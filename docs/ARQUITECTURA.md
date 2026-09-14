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

## La cola de limpieza

Una solicitud de limpieza es **estado actual**, no historial: es una cola que
se vacía. Por eso vive en su propia tabla, como `rooms`, y no en `movements`.
Lo inmutable es el movimiento que cada cambio suyo deja en el expediente de la
habitación, y por eso todo pasa por `recordMovement`: la solicitud hereda su
auditoría, su notificación y su sello de tiempo sin duplicar nada.

La solicitud va en **un solo sentido**, y eso son dos permisos, no uno:
`cleaning.request` para pedir (Recepción) y `cleaning.attend` para atender
(Ama de Llaves y Supervisión). Con un permiso único, Ama de Llaves podría
pedirse trabajo a sí misma y Recepción podría darse por atendida su propia
solicitud: ninguna de las dos cosas es lo que pasa en el piso. Cancelar admite
cualquiera de los dos, porque tanto quien pide como quien atiende pueden
descubrir que ese trabajo ya no hace falta.

Lo que ordena la cola es `cleaning_priorities.weight`, no el nombre ni el
color: el hotel puede intercalar una prioridad nueva entre dos existentes sin
tocar código. A igual peso ordena la antigüedad, así que nada se queda al
fondo para siempre.

Un índice único parcial impone la regla de que **una habitación no tiene dos
solicitudes pendientes**:

```sql
CREATE UNIQUE INDEX ux_solic_pendiente
  ON cleaning_requests(room_id) WHERE status = 'pendiente';
```

Pedirla otra vez sube la prioridad de la que ya había. Dos solicitudes no son
dos trabajos, y la cola tiene que decir cuánto falta por hacer, no cuántas
veces lo han pedido.

El cierre no depende de que alguien se acuerde: un tipo de movimiento marcado
con `closes_cleaning_request` —hoy «Limpieza terminada»— da por atendida la
solicitud pendiente de esa habitación dentro de la misma transacción, y sin
crear un movimiento aparte, porque no ocurrió nada aparte.

## Mientras el PMS no esté enlazado

El CDH y Arpón Enterprise llevan cada uno su copia del estado de la habitación.
Hasta que hablen entre ellos, la única garantía de que no se descuadren es que
quien opera lo tenga delante: los tipos de movimiento marcados con `warns_pms`
muestran el aviso **antes** de guardar, no como un mensaje que se desvanece
después. El nombre del PMS (`pms_name`) y el propio aviso (`pms_manual_sync`)
son configuraciones, no texto fijo: el día que se enlacen, se apaga sin tocar
código.

## Los reportes y la venta

Un reporte **no mueve el estado**. Ni el que se levanta con una acción, ni el
que abre un campo marcado en falla: los dos abren su pendiente y dejan la
habitación donde estaba, marcada en el rack con **«Reporte abierto»**.

*Fuera de servicio* es otra cosa: es lo que se hace con una habitación que tiene
un problema grave, de los que duran un día o más. Eso lo decide quien opera, y
tiene su propia acción. Que el sistema mandara ahí una habitación por un foco
fundido confundía dos situaciones muy distintas para quien mira el rack.

Una habitación puede entonces estar *Disponible limpio* con un reporte abierto,
y eso es deliberado: la limpieza de una salida se termina y se registra aunque
la TV siga sin señal —si no, el trabajo hecho no se podría anotar—, y quien
vende la ve con su aviso al lado.

El mecanismo anterior sigue existiendo, apagado: si una categoría declara
`pending_status_id`, un reporte suyo sí manda la habitación a ese estado. El
catálogo lo deja vacío —el caso normal— y desde Administración puede volver a
ponerse por categoría, sin tocar código.

## Incidencias

Una incidencia está **abierta** por cualquiera de dos vías:

1. **Por campo.** El valor actual de un campo coincide con alguno de los
   configurados en `is_incident_when` (*Plomería: Falla*). Se cierra sola al
   corregir el valor: no hay un estado de incidencia que mantener sincronizado.
2. **Por reporte.** Una acción marcada con `is_incident` la levantó —un
   reporte a Mantenimiento o a Sistemas, un daño, un bloqueo— y nada posterior
   la cerró.

Un reporte se cierra de dos maneras, las dos un movimiento del historial, nunca
un borrado:

| Cómo | Qué cierra |
|---|---|
| Acción de cierre de su misma área (*Mantenimiento completado*) | Lo pendiente de esa categoría |
| Acción de cierre con `closes_scope = 'habitacion'` (*Liberar habitación*) | Todo lo pendiente de la habitación |

Había una tercera: devolver la habitación a un estado de venta. Tenía sentido
cuando un reporte la sacaba de servicio —volver al servicio significaba que el
problema estaba resuelto—, pero desde que el reporte no mueve el estado, una
habitación puede estar *Disponible limpio* con su reporte abierto. Cerrarlo por
el estado borraría el pendiente sin que nadie lo hubiera atendido, así que ya
no cierra nada.

Los movimientos que cambiaron un campo se excluyen del conteo por reporte: el
valor actual del campo ya los representa, y contarlos otra vez sería contarlos
dos veces.

## No se libera con un pendiente abierto

**Liberar habitación** da por resueltos todos los pendientes de esa habitación
(`closes_incident` con `closes_scope = 'habitacion'`). Por eso se rechaza
mientras haya una incidencia abierta de una categoría marcada con
`blocks_release` —hoy Mantenimiento y Sistemas—, venga de un reporte o del valor
de un campo: darla por resuelta sin que nadie la atendiera sería borrar el
trabajo en vez de hacerlo. La comprobación vive en `recordMovement()`, la única
puerta de escritura, así que vale igual para la acción rápida y para el cambio
en bloque; en un lote, una sola habitación con pendiente detiene el lote entero.

Lo vigilado es **el cierre, no el estado**. Antes se vigilaba el paso a un
estado de venta, porque un reporte sacaba la habitación de servicio y volver al
servicio cerraba el pendiente solo. Desde que el reporte no mueve el estado, esa
puerta se cerró por otro lado: **volver a un estado de venta ya no cierra nada**
(ver *Incidencias*). Así, terminar una limpieza no tropieza con la regla, y el
pendiente sigue abierto y a la vista hasta que alguien lo cierre.

Lo que **no** bloquea: limpiar, comentar, adjuntar fotos, reportar, cambiar el
estado a mano, ni cerrar lo de su propia área —«Sistemas completado» es
justamente atenderlo—. Qué categorías bloquean se configura desde
Administración: es una casilla de la categoría, no una lista de códigos.

## La pantalla de registrar

Quince acciones sueltas en una rejilla obligan a leerlas todas para encontrar
una. Ahora van en grupos (`ACTION_GROUPS`) que siguen el orden del trabajo, y
la acción dice a cuál pertenece con `movement_types.action_group`.

Los grupos viajan con las acciones desde el servidor: la interfaz pinta lo que
le llega, en el orden en que le llega, sin saberse ninguna lista. De ahí salen
tres propiedades que no hay que programar aparte: un grupo sin acciones
visibles no se pinta —quien no puede reportar no ve la sección de reportes—,
una acción que el hotel cree desde Administración aparece igual (cae en «Otras
acciones» si no declara grupo), y mover una acción de sección es editar un
campo, no desplegar.

`one_entry` es el caso de los reportes. Los cinco —mantenimiento, fuera de
servicio, Sistemas, daño y discrepancia— se muestran como **una sola tarjeta**,
y el área se elige dentro. Reportar es un gesto; a quién va, un dato de ese
gesto. Las áreas que se ofrecen salen de la categoría de cada acción y de los
permisos de quien mira, así que no hay ninguna lista de departamentos escrita
en la interfaz.

Nada de esto cambia lo que una acción hace: el grupo es presentación, y
`recordMovement` no lo lee. Por eso se pudo reordenar la pantalla entera sin
tocar la puerta de escritura.

## Extensión sin código

Desde Administración se pueden agregar pisos, habitaciones, estados,
categorías, campos (con sus opciones y valores de incidencia), acciones
rápidas, departamentos, usuarios, roles y permisos. La interfaz se arma a
partir del catálogo, así que un campo nuevo aparece en el expediente y en los
reportes sin desplegar nada.

## La puesta al día de una base en uso

El hotel no reinstala: `npm run upgrade` pone al día la base con la que ya
trabaja. La regla de oro es que **sólo añade lo que falta**, para no pisar lo
que un administrador haya configurado ni tocar el historial. Esa regla tiene un
punto ciego, y conviene tenerlo escrito porque ya mordió dos veces.

**Lo que se inserta llega completo; lo que ya existe, no.** La puesta al día
inserta las filas del catálogo que faltan, así que una acción nueva nace con
todas sus banderas puestas. Pero una acción que YA está en la base no se vuelve
a insertar: si una versión posterior le añade una bandera —una columna nueva—,
esa fila se queda con el valor por defecto para siempre. Así fue como
«¿el huésped estará en la habitación?» no se preguntaba al reportar a Sistemas
ni a Mantenimiento: la columna existía, el catálogo la declaraba, y a las
acciones del hotel nunca les llegó.

De ahí los cuatro mecanismos, cada uno con su guarda:

- **`COLUMNAS_NUEVAS` + `backfill`** (`server/lib/db.js`) — el relleno corre una
  sola vez, justo al crear la columna: hasta ese momento nadie pudo
  configurarla, así que poner el valor previsto no pisa ninguna decisión. Para
  las banderas de las acciones el relleno **se escribe a partir del catálogo**
  (`banderaDeAccion`), no a mano: una lista copiada se queda atrás en cuanto la
  bandera se le añade a una acción más, y nada avisa.
- **`RENOMBRES` / `RETIRADOS`** — sólo actúan si la fila conserva exactamente el
  valor con el que se publicó y nada la usa. Si el hotel ya la cambió, la
  decisión es suya.
- **Referencias a un estado retirado** — una acción cuyo destino acaba de
  retirarse deja de funcionar: el CDH se niega con «Estado desconocido o
  inactivo» y el área se queda sin poder reportar ni cerrar su trabajo. Apuntar
  a un retirado no es la decisión de nadie, es un resto, así que se reapunta a
  lo que el catálogo declara hoy. Un destino vigente no se toca nunca, aunque
  difiera del catálogo.
- **`CORRECTIVOS`** — para lo que una versión publicó a medias y ya no tiene
  arreglo automático: la columna existe, así que su relleno no volverá a
  correr. Se aplican **una sola vez en la vida de la base** y la bitácora
  —inmutable— lleva la cuenta con una marca `correctivo:<id>`. Por eso un
  correctivo repara la base del hotel hoy y, si mañana Administración cambia lo
  mismo a mano, no lo deshace.

Las pruebas cierran el círculo: una quita las columnas de banderas y exige que
la puesta al día las vuelva a sembrar con lo que el catálogo dice; otra levanta
en un proceso aparte una base como la del hotel —banderas apagadas, permiso sin
repartir— y exige que los correctivos la reparen y que la segunda pasada no
cambie nada. Y en CI, el trabajo *Actualización desde la versión anterior*
siembra con el commit base del PR y verifica invariantes que valen para
cualquier versión: el historial intacto, ninguna habitación en un estado
retirado, ninguna referencia colgando y la operación viva.
