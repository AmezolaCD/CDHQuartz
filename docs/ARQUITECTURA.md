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

## Incidencias

Una incidencia está **abierta** cuando el valor actual de un campo coincide
con alguno de los valores configurados en `is_incident_when`. Se cierra sola
al corregir el valor: no hay un estado de incidencia que mantener sincronizado.

## Extensión sin código

Desde Administración se pueden agregar pisos, habitaciones, estados,
categorías, campos (con sus opciones y valores de incidencia), acciones
rápidas, departamentos, usuarios, roles y permisos. La interfaz se arma a
partir del catálogo, así que un campo nuevo aparece en el expediente y en los
reportes sin desplegar nada.
