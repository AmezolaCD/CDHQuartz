# CDH — Control de Detalles por Habitación

Expediente digital y auditable de cada habitación del **Hotel Quartz**.
Cada habitación tiene un **estado actual** y un **historial completo**: toda
modificación genera automáticamente un movimiento que responde *qué cambió,
quién, cuándo, en qué habitación, qué departamento, qué había antes, qué quedó
después y por qué*.

---

## Puesta en marcha

```bash
npm install
npm start            # http://localhost:3000
```

La primera ejecución crea la base de datos y carga el catálogo y las 155
habitaciones. Para recargar desde cero:

```bash
npm run reset && npm run seed
npm test             # 25 pruebas: distribución, transacciones, inmutabilidad y permisos
```

### Usuarios iniciales

Contraseña inicial para todos: `Quartz#2026` (se exige cambiarla en el primer
acceso). Se puede fijar otra con `CDH_SEED_PASSWORD` antes de sembrar.

| Usuario | Rol | Alcance |
|---|---|---|
| `admin` | Administrador | Acceso completo |
| `gerencia` | Gerencia | Consulta todo, no opera |
| `supervisor` | Supervisor | Opera todas las categorías |
| `amadellaves` | Ama de Llaves | Sus campos |
| `mantenimiento` | Mantenimiento | Sus campos |
| `sistemas` | **Administrador** | **Usuario maestro: acceso completo** |
| `recepcion` | Recepción | Consulta y observaciones autorizadas |

### Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `CDH_DATA_DIR` | `./data` | Base de datos y fotografías |
| `CDH_DB_FILE` | `./data/cdh.sqlite` | Ruta del archivo SQLite |
| `CDH_TZ` | `America/Mexico_City` | Zona horaria inicial (después se administra desde la app) |
| `CDH_SEED_PASSWORD` | `Quartz#2026` | Contraseña de los usuarios iniciales |

---

## Despliegue con Docker

```bash
cp .env.example .env          # defina CDH_SEED_PASSWORD
docker compose up -d --build  # http://127.0.0.1:3000
```

La imagen parte de `node:22-alpine`. `better-sqlite3` incluye binarios
precompilados para musl, así que no hace falta cadena de compilación: la
imagen final no lleva gcc, python ni node-gyp.

| Aspecto | Cómo queda resuelto |
|---|---|
| Usuario | Corre como `node` (uid 1000); nada se ejecuta como root |
| Persistencia | Volumen `cdh-data` en `/app/data`: base SQLite y fotografías |
| Señales | `tini` como PID 1, para que `docker stop` termine ordenadamente |
| Salud | `HEALTHCHECK` contra `/api/health` con el `fetch` nativo de Node 22 |
| Exposición | Publica en `127.0.0.1` por defecto, para quedar tras un proxy inverso |

### Variables

| Variable | Por defecto | Descripción |
|---|---|---|
| `CDH_SEED_PASSWORD` | — | **Obligatoria.** Contraseña de los 7 usuarios iniciales; sólo se aplica en el primer arranque |
| `CDH_TZ` | `America/Mexico_City` | Zona horaria que sella cada movimiento |
| `CDH_PORT` | `3000` | Puerto publicado en el anfitrión |
| `CDH_BIND` | `127.0.0.1` | Interfaz publicada; use `0.0.0.0` sólo si ya resolvió el HTTPS |

### Notas de operación

El primer arranque siembra las 155 habitaciones y los 7 usuarios; los
siguientes detectan la base existente y no la tocan.

Con un **bind mount** en lugar del volumen con nombre, el anfitrión impone la
propiedad del directorio: hay que ceder `data/` al uid 1000
(`sudo chown -R 1000:1000 ./data`) o el proceso no podrá escribir.

Detrás de un proxy inverso, propague `X-Forwarded-Proto`: la aplicación ya
tiene `trust proxy` y marca la cookie de sesión como `secure` cuando la
petición llegó por HTTPS.

Respaldo del estado completo:

```bash
docker run --rm -v cdhquartz_cdh-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/cdh-$(date +%F).tar.gz -C /data .
```

## Distribución real: 155 habitaciones en 9 pisos

Tomada del rack vertical del hotel. El índice de columna corresponde a la
posición visual A–S; los espacios sin habitación quedan **vacíos** en el mapa.

| Piso | Hab. | Números |
|---|---|---|
| 3 | 12 | 301–312 |
| 4 | 19 | 401–406, 408, 410, 411–420, 422 |
| 5 | 18 | 501–506, 508, 510, 512–520, 522 |
| 6 | 19 | 601–606, 608, 610, 611–620, 622 |
| 7 | 19 | 701–706, 708, 710, 711–720, 722 |
| 8 | 19 | 801–806, 808, 810, 811–820, 822 |
| 9 | 19 | 901–906, 908, 910, 911–920, 922 |
| 10 | 19 | 1001–1006, 1008, 1010, 1011–1020, 1022 |
| 11 | 11 | 1101–1104, 1106–1112 |
| **Total** | **155** | |

Incluye las habitaciones terminadas en 01 de cada piso (301, 401, 501, 601,
701, 801, 901, 1001, 1101). Altas, bajas y reposicionamiento se hacen desde
**Administración → Habitaciones**; la baja es lógica y conserva el historial.

---

## Garantías del sistema

**Operación transaccional.** Cada guardado ejecuta en una sola transacción:
actualizar el estado actual → crear el o los movimientos → adjuntar
fotografías → generar notificaciones → escribir la auditoría. Si cualquier
paso falla, se revierte todo (probado en `test/cdh.test.js`).

**Historial inmutable.** `movements`, `attachments` y `audit_log` tienen
disparadores en SQLite que rechazan `UPDATE` y `DELETE`: ni la aplicación
puede alterar el historial. Una corrección es un **movimiento nuevo** que
referencia al anterior mediante `corrects_movement_id`.

**Sin borrado físico.** Habitaciones y usuarios sólo se desactivan
(`active = 0`); sus disparadores rechazan `DELETE`.

**Tiempo del servidor.** Nunca se confía en el reloj del navegador. Cada
movimiento guarda ISO-8601 UTC, epoch, y fecha y hora en la zona configurable
del hotel.

**Alcance por departamento.** Los roles marcados con `department_scope` sólo
escriben en categorías de su departamento o en categorías generales. Ama de
Llaves no puede tocar campos de Sistemas, y viceversa.

**Reincidencia por evento.** Un reporte que afecta varios campos genera varios
movimientos pero cuenta como **una** incidencia: la reincidencia agrupa por
`batch_id`, no por filas.

---

## Modelo de datos

```
departments  roles  permissions  role_permissions  users  sessions
floors  room_types  room_statuses  rooms          ← estado actual
categories  fields  room_details                  ← estado actual por campo
movement_types  movements                         ← historial inmutable
attachments  audit_log  notifications  settings
```

El **estado actual** (`rooms`, `room_details`) vive separado del **historial**
(`movements`). Los movimientos guardan además una copia del nombre del
usuario, departamento y categoría, para que renombrar un catálogo no altere el
pasado.

Un movimiento registra: habitación, piso, usuario, departamento, categoría,
tipo, acción, campo modificado, valor anterior, valor nuevo, estado anterior,
estado nuevo, comentario, severidad, incidencia, fotografías y sello de tiempo.

---

## API

Todas las rutas van bajo `/api` y usan una cookie de sesión `httpOnly`.

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/auth/login` · `/auth/logout` · `/auth/password` | Sesión (auditada) |
| `GET` | `/auth/me` · `/bootstrap` | Usuario y catálogos |
| `GET` | `/rooms/floors` · `/rooms/floors/:id/map` | Pisos y mapa del rack |
| `GET` | `/rooms/search?q=618` | Búsqueda global |
| `GET` | `/rooms/:id` · `/rooms/:id/history` | Expediente e historial |
| `POST` | `/rooms/:id/movements` | **Registro transaccional** (multipart con fotos) |
| `GET` | `/dashboard` · `/dashboard/gerencial` · `/dashboard/floor/:id` | Paneles |
| `GET` | `/dashboard/attention` · `/activity` · `/recurrence` | Atención, actividad, reincidencia |
| `GET` | `/reports/movements` · `/reports/summary` | Reportes |
| `GET` | `/reports/export?format=csv\|xlsx\|pdf` | Exportación |
| `GET` | `/audit` · `/notifications` | Auditoría y avisos |
| `*` | `/admin/*` | Administración (CRUD auditado) |
| `GET` | `/integrations` | Integraciones futuras (responden 501) |

### Permisos

`room.view`, `room.edit`, `room.status`, `movement.create`, `history.view`,
`photo.upload`, `report.view`, `report.export`, `dashboard.manage`,
`audit.view`, `notification.manage`, `admin.users`, `admin.rooms`,
`admin.catalog`, `admin.settings`.

Son independientes y se asignan por rol desde **Administración → Usuarios y
roles**. Cambiar permisos, rol o contraseña revoca las sesiones abiertas.

---

## Integraciones futuras

`/api/integrations` declara el contrato para PMS, Ama de Llaves,
Mantenimiento, Sistemas, WiFi, telefonía, TV, cerraduras e IoT. La estructura
está lista pero **ninguna está implementada**: responden `501` describiendo el
contrato esperado. Cuando se habiliten, los eventos entrantes generarán
movimientos auditables como cualquier otro cambio.

---

## Notas técnicas

- Node.js ≥ 22 (lo exige `better-sqlite3`), Express 5, SQLite (better-sqlite3). Sin proceso de compilación
  en el cliente: HTML, CSS y JavaScript nativos.
- Las fotografías se guardan en `data/uploads/AAAA-MM-DD/` y sólo se sirven a
  usuarios autenticados con permiso de consulta.
- `npm audit` reporta un aviso moderado en `uuid`, dependencia transitiva de
  `exceljs`, que afecta únicamente a llamadas con búfer controlado por el
  atacante; la generación de Excel no expone esa ruta.
