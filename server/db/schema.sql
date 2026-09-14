-- ============================================================================
-- CDH - Control de Detalles por Habitación | Hotel Quartz
-- Esquema normalizado. El estado actual vive separado del historial.
-- Los movimientos y la bitácora de auditoría son inmutables (triggers).
-- ============================================================================
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- Seguridad
CREATE TABLE IF NOT EXISTS departments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#64748b',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS permissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  grp           TEXT NOT NULL DEFAULT 'General',
  description   TEXT
);

CREATE TABLE IF NOT EXISTS roles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  description      TEXT,
  -- 1 = el usuario sólo puede escribir en categorías de su propio departamento
  department_scope INTEGER NOT NULL DEFAULT 0,
  is_system        INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  email         TEXT,
  password_hash TEXT NOT NULL,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  department_id INTEGER REFERENCES departments(id),
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_users_role ON users(role_id);
CREATE INDEX IF NOT EXISTS ix_users_dept ON users(department_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

-- ----------------------------------------------------------- Inventario físico
CREATE TABLE IF NOT EXISTS floors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  number        INTEGER NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS room_types (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1
);

-- Catálogo configurable de estados. Cada estado aporta a los contadores
-- del dashboard mediante banderas semánticas (no se depende del color).
CREATE TABLE IF NOT EXISTS room_statuses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  code               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  icon               TEXT NOT NULL DEFAULT 'circle',
  color              TEXT NOT NULL DEFAULT '#64748b',
  description        TEXT,
  counts_ready       INTEGER NOT NULL DEFAULT 0,
  counts_cleaning    INTEGER NOT NULL DEFAULT 0,
  counts_maintenance INTEGER NOT NULL DEFAULT 0,
  counts_blocked     INTEGER NOT NULL DEFAULT 0,
  counts_attention   INTEGER NOT NULL DEFAULT 0,
  counts_pending     INTEGER NOT NULL DEFAULT 0,
  -- Prioridad del estado en la sección "Requiere atención": a mayor número,
  -- más arriba aparece. Sólo se toma en cuenta si counts_attention = 1.
  attention_weight   INTEGER NOT NULL DEFAULT 3,
  -- 1 = estado de VENTA: exige que la habitación esté sin huésped. Ninguna
  -- habitación ocupada puede quedar en un estado marcado así.
  requires_vacant    INTEGER NOT NULL DEFAULT 0,
  -- Estado al que pasa la habitación cuando se termina de limpiarla. Depende
  -- de dónde venga: una "Ocupado sucio" queda "Ocupado limpio" y una "Salida"
  -- queda "Disponible limpio". Sin esto, "Limpieza terminada" tendría que
  -- apuntar a un único destino y mentir en la mitad de los casos.
  clean_status_id    INTEGER REFERENCES room_statuses(id),
  sort_order         INTEGER NOT NULL DEFAULT 0,
  is_system          INTEGER NOT NULL DEFAULT 0,
  active             INTEGER NOT NULL DEFAULT 1
);

-- Catálogo de OCUPACIÓN. EN DESUSO.
--
-- Fue un segundo eje de la habitación mientras el CDH no hablaba con el PMS.
-- Los estados del hotel ya dicen si hay huésped (Ocupado limpio, Ocupado
-- sucio, Salida), así que el eje sobraba; lo que hacía falta de verdad —si el
-- huésped estará dentro cuando suba Mantenimiento o Sistemas— es ahora un dato
-- del reporte (movements.guest_present), no un estado.
--
-- La tabla NO se elimina: los movimientos ya registrados apuntan a sus filas y
-- el historial es inmutable. Sus filas quedan dadas de baja (active = 0).
CREATE TABLE IF NOT EXISTS room_occupancies (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  icon              TEXT NOT NULL DEFAULT 'user',
  color             TEXT NOT NULL DEFAULT '#64748b',
  description       TEXT,
  -- 1 = hay huésped dentro.
  counts_occupied   INTEGER NOT NULL DEFAULT 0,
  -- 1 = el huésped pidió no ser molestado: no se entra a la habitación.
  do_not_disturb    INTEGER NOT NULL DEFAULT 0,
  -- 1 = ocupación "sin huésped". Es a la que vuelve una habitación cuando se
  -- pone de nuevo a la venta.
  is_default        INTEGER NOT NULL DEFAULT 0,
  -- Estado al que pasa una habitación A LA VENTA cuando entra un huésped:
  -- sin él, un check-in dejaría la habitación disponible para venderse otra vez.
  target_status_id  INTEGER REFERENCES room_statuses(id),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_system         INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1
);

-- Estado ACTUAL de la habitación. El historial vive en `movements`.
CREATE TABLE IF NOT EXISTS rooms (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  number            TEXT NOT NULL UNIQUE,
  floor_id          INTEGER NOT NULL REFERENCES floors(id),
  room_type_id      INTEGER REFERENCES room_types(id),
  status_id         INTEGER NOT NULL REFERENCES room_statuses(id),
  occupancy_id      INTEGER REFERENCES room_occupancies(id),
  grid_row          INTEGER NOT NULL DEFAULT 1,   -- fila visual (equivale al piso)
  grid_col          INTEGER NOT NULL DEFAULT 1,   -- columna visual A..S = 1..19
  notes             TEXT,
  active            INTEGER NOT NULL DEFAULT 1,   -- baja lógica: nunca se borra
  status_changed_at TEXT,
  occupancy_changed_at TEXT,
  updated_at        TEXT,
  updated_by        INTEGER REFERENCES users(id),
  last_movement_id  INTEGER,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_rooms_floor  ON rooms(floor_id);
CREATE INDEX IF NOT EXISTS ix_rooms_status ON rooms(status_id);
-- El índice de `occupancy_id` NO puede ir aquí: en una base en uso la columna
-- todavía no existe cuando se ejecuta este archivo (la añade el paso de
-- columnas nuevas, después). Vive en INDICES_TARDIOS, en server/lib/db.js.
CREATE UNIQUE INDEX IF NOT EXISTS ux_rooms_grid ON rooms(grid_row, grid_col);

-- ------------------------------------------- Solicitudes de limpieza
-- Recepción pide, Ama de Llaves atiende. La solicitud es ESTADO ACTUAL —una
-- cola de trabajo—, no historial: vive en su propia tabla y cada cambio suyo
-- deja además un movimiento, que es lo inmutable.
CREATE TABLE IF NOT EXISTS cleaning_priorities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  icon            TEXT NOT NULL DEFAULT 'clock',
  color           TEXT NOT NULL DEFAULT '#64748b',
  description     TEXT,
  -- A mayor peso, más arriba en la cola. Es lo que ordena, no el nombre ni el
  -- color: así se puede insertar una prioridad nueva entre dos existentes.
  weight          INTEGER NOT NULL DEFAULT 1,
  -- Severidad del aviso que genera. Una urgente despierta a quien haga falta.
  notify_severity TEXT NOT NULL DEFAULT 'normal',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_system       INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cleaning_requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id           INTEGER NOT NULL REFERENCES rooms(id),
  room_number       TEXT NOT NULL,
  floor_id          INTEGER NOT NULL REFERENCES floors(id),
  floor_number      INTEGER NOT NULL,
  priority_id       INTEGER NOT NULL REFERENCES cleaning_priorities(id),
  -- Copia del nombre y del peso: si mañana se renombra la prioridad, la cola
  -- de ayer sigue contando lo que decía entonces.
  priority_code     TEXT NOT NULL,
  priority_name     TEXT NOT NULL,
  priority_weight   INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|atendida|cancelada
  note              TEXT,
  requested_by      INTEGER NOT NULL REFERENCES users(id),
  requested_by_name TEXT NOT NULL,
  requested_department TEXT,
  requested_at      TEXT NOT NULL,
  requested_epoch   INTEGER NOT NULL,
  local_date        TEXT NOT NULL,
  local_time        TEXT NOT NULL,
  movement_id       INTEGER REFERENCES movements(id),
  closed_by         INTEGER REFERENCES users(id),
  closed_by_name    TEXT,
  closed_at         TEXT,
  closed_epoch      INTEGER,
  closed_reason     TEXT,
  closed_movement_id INTEGER REFERENCES movements(id)
);
CREATE INDEX IF NOT EXISTS ix_solic_room  ON cleaning_requests(room_id, status);
CREATE INDEX IF NOT EXISTS ix_solic_cola  ON cleaning_requests(status, priority_weight DESC, requested_epoch);
-- Una habitación no puede tener dos solicitudes pendientes a la vez: la
-- segunda sube la prioridad de la primera en lugar de duplicar el trabajo.
CREATE UNIQUE INDEX IF NOT EXISTS ux_solic_pendiente
  ON cleaning_requests(room_id) WHERE status = 'pendiente';

-- --------------------------------------------------- Categorías y campos
CREATE TABLE IF NOT EXISTS categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  icon          TEXT NOT NULL DEFAULT 'folder',
  color         TEXT NOT NULL DEFAULT '#64748b',
  -- Una incidencia abierta de esta categoría impide devolver la habitación
  -- al servicio: no se libera una habitación con un pendiente de esta área.
  blocks_release INTEGER NOT NULL DEFAULT 0,
  -- Estado al que pasa una habitación EN SERVICIO cuando esta área le detecta
  -- una falla. Sin él, marcar "Plomería: Falla" dejaba la habitación a la venta.
  pending_status_id INTEGER REFERENCES room_statuses(id),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fields (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  code          TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'select', -- select|text|textarea|boolean|number|date
  options       TEXT,                            -- JSON array para select
  default_value TEXT,
  help_text     TEXT,
  is_incident_when TEXT,                          -- JSON array de valores que abren incidencia
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_fields_category ON fields(category_id);

-- Valor ACTUAL de cada campo por habitación (una fila por habitación+campo).
CREATE TABLE IF NOT EXISTS room_details (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id           INTEGER NOT NULL REFERENCES rooms(id),
  field_id          INTEGER NOT NULL REFERENCES fields(id),
  value             TEXT,
  updated_at        TEXT,
  updated_by        INTEGER REFERENCES users(id),
  last_movement_id  INTEGER,
  UNIQUE (room_id, field_id)
);
CREATE INDEX IF NOT EXISTS ix_details_room ON room_details(room_id);

-- ------------------------------------------------------ Tipos de movimiento
CREATE TABLE IF NOT EXISTS movement_types (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  category_id       INTEGER REFERENCES categories(id),
  target_status_id  INTEGER REFERENCES room_statuses(id),
  -- Ocupación a la que lleva la acción. En desuso: la ocupación dejó de ser un
  -- eje de la habitación (ver room_occupancies).
  target_occupancy_id INTEGER REFERENCES room_occupancies(id),
  -- 1 = la acción lleva al destino que marque `clean_status_id` del estado
  -- ACTUAL de la habitación, en lugar de a un estado fijo.
  target_from_clean   INTEGER NOT NULL DEFAULT 0,
  -- 1 = al registrarla se pregunta si el huésped estará en la habitación. Es
  -- lo que Mantenimiento y Sistemas necesitan saber antes de subir.
  asks_guest_present  INTEGER NOT NULL DEFAULT 0,
  -- 1 = al registrarla se da por atendida la solicitud de limpieza pendiente
  -- de esa habitación, si la hubiera.
  closes_cleaning_request INTEGER NOT NULL DEFAULT 0,
  -- 1 = cambia algo que el PMS también lleva, así que hay que repetirlo allá
  -- mientras los dos sistemas no estén enlazados.
  warns_pms           INTEGER NOT NULL DEFAULT 0,
  icon              TEXT NOT NULL DEFAULT 'bolt',
  severity          TEXT NOT NULL DEFAULT 'normal', -- normal|alta|critica
  is_incident       INTEGER NOT NULL DEFAULT 0,
  closes_incident   INTEGER NOT NULL DEFAULT 0,
  -- Alcance del cierre: 'categoria' cierra lo pendiente de su propia área
  -- ("Mantenimiento completado" no cierra un reporte a Sistemas);
  -- 'habitacion' cierra todo lo pendiente de la habitación ("Liberar").
  closes_scope      TEXT NOT NULL DEFAULT 'categoria',
  requires_comment  INTEGER NOT NULL DEFAULT 0,
  requires_photo    INTEGER NOT NULL DEFAULT 0,
  allows_photo      INTEGER NOT NULL DEFAULT 1,
  is_quick_action   INTEGER NOT NULL DEFAULT 0,
  -- Un reporte se levanta HACIA otra área: cualquier departamento puede
  -- abrirlo. Iniciar o cerrar el trabajo sigue siendo del área responsable.
  cross_department  INTEGER NOT NULL DEFAULT 0,
  notify            INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_system         INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1
);

-- ============================ HISTORIAL INMUTABLE ============================
-- Un movimiento responde: QUÉ, QUIÉN, CUÁNDO, DÓNDE, ANTES, DESPUÉS y POR QUÉ.
-- Los nombres se guardan como snapshot para que el historial no cambie si
-- después se renombra un usuario, departamento o categoría.
CREATE TABLE IF NOT EXISTS movements (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id            INTEGER NOT NULL REFERENCES rooms(id),
  room_number        TEXT NOT NULL,
  floor_id           INTEGER NOT NULL REFERENCES floors(id),
  floor_number       INTEGER NOT NULL,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  user_name          TEXT NOT NULL,
  department_id      INTEGER REFERENCES departments(id),
  department_name    TEXT,
  category_id        INTEGER REFERENCES categories(id),
  category_name      TEXT,
  movement_type_id   INTEGER REFERENCES movement_types(id),
  action             TEXT NOT NULL,          -- etiqueta legible de la acción
  action_code        TEXT NOT NULL,
  field_id           INTEGER REFERENCES fields(id),
  field_label        TEXT,                   -- campo modificado
  old_value          TEXT,                   -- ANTES
  new_value          TEXT,                   -- DESPUÉS
  old_status_id      INTEGER REFERENCES room_statuses(id),
  new_status_id      INTEGER REFERENCES room_statuses(id),
  old_status_name    TEXT,
  new_status_name    TEXT,
  old_occupancy_id   INTEGER REFERENCES room_occupancies(id),
  new_occupancy_id   INTEGER REFERENCES room_occupancies(id),
  old_occupancy_name TEXT,
  new_occupancy_name TEXT,
  -- ¿Estará el huésped en la habitación? 'si' | 'no' | 'desconocido'.
  -- Viaja con el reporte para que el área que sube sepa qué se va a encontrar.
  guest_present      TEXT,
  comment            TEXT,                   -- POR QUÉ
  severity           TEXT NOT NULL DEFAULT 'normal',
  is_incident        INTEGER NOT NULL DEFAULT 0,
  closes_incident    INTEGER NOT NULL DEFAULT 0,
  corrects_movement_id INTEGER REFERENCES movements(id), -- corrección = nuevo movimiento
  batch_id           TEXT,                   -- agrupa movimientos de un mismo guardado
  photo_count        INTEGER NOT NULL DEFAULT 0,
  -- Sello de tiempo del SERVIDOR. Nunca se confía en el reloj del navegador.
  created_at         TEXT NOT NULL,          -- ISO-8601 UTC
  created_epoch      INTEGER NOT NULL,       -- epoch ms
  local_date         TEXT NOT NULL,          -- YYYY-MM-DD en zona del hotel
  local_time         TEXT NOT NULL,          -- HH:MM:SS en zona del hotel
  timezone           TEXT NOT NULL,
  ip                 TEXT
);
CREATE INDEX IF NOT EXISTS ix_mov_room   ON movements(room_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_mov_date   ON movements(local_date);
CREATE INDEX IF NOT EXISTS ix_mov_epoch  ON movements(created_epoch DESC);
CREATE INDEX IF NOT EXISTS ix_mov_dept   ON movements(department_id);
CREATE INDEX IF NOT EXISTS ix_mov_user   ON movements(user_id);
CREATE INDEX IF NOT EXISTS ix_mov_cat    ON movements(category_id);
CREATE INDEX IF NOT EXISTS ix_mov_inc    ON movements(is_incident, created_epoch DESC);
CREATE INDEX IF NOT EXISTS ix_mov_batch  ON movements(batch_id);

CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  movement_id   INTEGER NOT NULL REFERENCES movements(id),
  room_id       INTEGER NOT NULL REFERENCES rooms(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  user_name     TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'general', -- antes|despues|general
  filename      TEXT NOT NULL,
  original_name TEXT,
  mime_type     TEXT,
  size_bytes    INTEGER,
  width         INTEGER,
  height        INTEGER,
  created_at    TEXT NOT NULL,
  local_date    TEXT NOT NULL,
  local_time    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_att_mov  ON attachments(movement_id);
CREATE INDEX IF NOT EXISTS ix_att_room ON attachments(room_id);

-- Bitácora global: login, logout, permisos, usuarios, habitaciones,
-- categorías, configuraciones... además de los movimientos operativos.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  entity_label  TEXT,
  action        TEXT NOT NULL,   -- login|logout|create|update|deactivate|movement|...
  actor_user_id INTEGER REFERENCES users(id),
  actor_name    TEXT,
  actor_role    TEXT,
  department_id INTEGER REFERENCES departments(id),
  before_json   TEXT,            -- ANTES
  after_json    TEXT,            -- DESPUÉS
  reason        TEXT,            -- POR QUÉ
  movement_id   INTEGER REFERENCES movements(id),
  room_id       INTEGER REFERENCES rooms(id),
  ip            TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  created_epoch INTEGER NOT NULL,
  local_date    TEXT NOT NULL,
  local_time    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_epoch  ON audit_log(created_epoch DESC);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_audit_actor  ON audit_log(actor_user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'normal',
  title         TEXT NOT NULL,
  body          TEXT,
  room_id       INTEGER REFERENCES rooms(id),
  room_number   TEXT,
  movement_id   INTEGER REFERENCES movements(id),
  department_id INTEGER REFERENCES departments(id),
  role_id       INTEGER REFERENCES roles(id),
  created_at    TEXT NOT NULL,
  created_epoch INTEGER NOT NULL,
  resolved_at   TEXT,
  resolved_by   INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_notif_epoch ON notifications(created_epoch DESC);

-- Departamentos a los que va dirigida una notificación. Sin filas, la
-- notificación es general y la ve cualquiera con permiso de atenderlas.
CREATE TABLE IF NOT EXISTS notification_recipients (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  department_id   INTEGER NOT NULL REFERENCES departments(id),
  PRIMARY KEY (notification_id, department_id)
);
CREATE INDEX IF NOT EXISTS ix_notif_dest ON notification_recipients(department_id);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TEXT NOT NULL,
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT,
  label         TEXT,
  grp           TEXT NOT NULL DEFAULT 'General',
  type          TEXT NOT NULL DEFAULT 'text',
  updated_at    TEXT,
  updated_by    INTEGER REFERENCES users(id)
);

-- ====================== INMUTABILIDAD DEL HISTORIAL =========================
-- SQLite impone la regla al nivel más bajo: ni la aplicación puede alterar
-- o borrar historial. Una corrección se registra como un movimiento nuevo.
-- Las fotos se insertan dentro de la misma transacción que el movimiento,
-- por lo que un movimiento nunca necesita actualizarse después de creado.
CREATE TRIGGER IF NOT EXISTS trg_movements_no_update
BEFORE UPDATE ON movements
BEGIN
  SELECT RAISE(ABORT, 'Los movimientos son inmutables: registre un movimiento de corrección.');
END;

CREATE TRIGGER IF NOT EXISTS trg_movements_no_delete
BEFORE DELETE ON movements
BEGIN
  SELECT RAISE(ABORT, 'Los movimientos no se pueden eliminar.');
END;

CREATE TRIGGER IF NOT EXISTS trg_attachments_no_update
BEFORE UPDATE ON attachments
BEGIN
  SELECT RAISE(ABORT, 'Las fotografías del historial son inmutables.');
END;

CREATE TRIGGER IF NOT EXISTS trg_attachments_no_delete
BEFORE DELETE ON attachments
BEGIN
  SELECT RAISE(ABORT, 'Las fotografías del historial no se pueden eliminar.');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'La bitácora de auditoría es inmutable.');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'La bitácora de auditoría no se puede eliminar.');
END;

-- Las habitaciones se dan de baja lógicamente (active=0), nunca se borran,
-- para no dejar historial huérfano.
CREATE TRIGGER IF NOT EXISTS trg_rooms_no_delete
BEFORE DELETE ON rooms
BEGIN
  SELECT RAISE(ABORT, 'Las habitaciones no se eliminan: desactívelas para conservar su historial.');
END;

CREATE TRIGGER IF NOT EXISTS trg_users_no_delete
BEFORE DELETE ON users
BEGIN
  SELECT RAISE(ABORT, 'Los usuarios no se eliminan: desactívelos para conservar su historial.');
END;
