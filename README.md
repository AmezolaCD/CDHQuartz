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
npm test             # 32 pruebas de servidor: distribución, transacciones, inmutabilidad, permisos y puesta al día
npm run test:ui      # 9 pruebas en navegador: apilado de paneles, recorrido de operación y errores de consola
```

### Logo del hotel

Deje el archivo en `public/assets/logo.svg` (o `.png`, `.webp`, `.jpg`) y la
interfaz lo usa en la pantalla de acceso y en la barra superior. El servidor
lo detecta solo: no hay que reiniciar ni configurar nada. Conviene que sea
monocromo y con fondo transparente, porque en la barra se invierte a blanco.
Sin archivo, se muestra la marca de texto «CDH».

### Windows: error de Visual Studio al instalar

Si `npm ci` intenta compilar `better-sqlite3` con node-gyp y falla pidiendo
Visual Studio, instale sin ejecutar scripts:

```bash
npm ci --ignore-scripts
```

El paquete incluye el binario ya compilado para Windows; npm lanza node-gyp
sólo por la presencia de `binding.gyp`. Ninguna dependencia del proyecto
necesita scripts de instalación.

### Actualizar una instalación en uso

`npm run reset` **borra los datos**. Para poner al día una base que ya está
operando —tras un `git pull` que añade estados, campos o acciones nuevas— use:

```bash
npm run upgrade                  # añade lo que falte
npm run upgrade -- --dry-run     # muestra el plan sin escribir nada
```

Sólo **añade**: nunca sobrescribe ni elimina, así que respeta lo que se haya
configurado desde Administración (un estado renombrado, un umbral ajustado).
Un campo nuevo se siembra además en todas las habitaciones ya existentes. El
historial de movimientos no se toca, y cada ejecución queda en la bitácora.

Dos opciones explícitas, porque cambian valores ya definidos:

```bash
npm run upgrade -- --timezone=America/Tijuana   # cambia la zona horaria del hotel
npm run upgrade -- --promote=sistemas           # da rol Administrador (recuperación de acceso)
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
| `CDH_TZ` | `America/Tijuana` | Zona horaria inicial (después se administra desde la app) |
| `CDH_SEED_PASSWORD` | `Quartz#2026` | Contraseña de los usuarios iniciales |

---

## Despliegue con Docker

```bash
cp .env.example .env          # defina CDH_SEED_PASSWORD
docker compose up -d --build  # http://127.0.0.1:3000
```

La imagen parte de `node:22-alpine`. `better-sqlite3` publica sus binarios
dentro del propio paquete, uno por plataforma, así que no hace falta cadena de
compilación: la imagen final no lleva gcc, python ni node-gyp.

Eso sí, el paquete publica también su `binding.gyp`, y con eso npm lanza
`node-gyp rebuild` por su cuenta aunque el binario ya esté ahí. Por eso la
instalación va con `--ignore-scripts`: sin esa bandera la construcción falla en
Alpine pidiendo Python. Ninguna dependencia del proyecto declara un script de
instalación propio, así que no se pierde nada. El CI construye la imagen y la
arranca en cada cambio, para que esto no vuelva a descubrirse en el hotel.

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
| `CDH_TZ` | `America/Tijuana` | Zona horaria que sella cada movimiento |
| `CDH_PORT` | `3000` | Puerto publicado en el anfitrión |
| `CDH_BIND` | `127.0.0.1` | Interfaz publicada; use `0.0.0.0` sólo si ya resolvió el HTTPS |
| `CDH_DOMAIN` | — | Dominio del despliegue con Caddy; obligatoria sólo con `docker-compose.caddy.yml` |

### Notas de operación

El primer arranque siembra las 155 habitaciones y los 7 usuarios; los
siguientes detectan la base existente y no la tocan.

Con un **bind mount** en lugar del volumen con nombre, el anfitrión impone la
propiedad del directorio: hay que ceder `data/` al uid 1000
(`sudo chown -R 1000:1000 ./data`) o el proceso no podrá escribir.

Detrás de un proxy inverso, propague `X-Forwarded-Proto`: la aplicación ya
tiene `trust proxy` y marca la cookie de sesión como `secure` cuando la
petición llegó por HTTPS.

### Respaldos

`npm run backup` hace una copia **en caliente**, sin detener el servicio:

```bash
docker compose exec cdh npm run backup          # a /app/data/backups/
docker compose exec cdh npm run backup -- --keep=30
```

Copiar el `.sqlite` con `cp` mientras el servidor escribe produce un archivo
roto: el modo WAL deja parte de los datos fuera. Este comando usa la copia de
seguridad en línea de SQLite, que entrega un archivo único y consistente
aunque haya movimientos registrándose en ese momento.

Un respaldo en el mismo disco no protege de que el disco falle: **bájelo de la
máquina**.

```bash
# Diario a las 03:00, y una copia fuera del servidor.
0 3 * * * cd /opt/cdh && docker compose exec -T cdh npm run backup --silent
```

El estado completo, incluidas las fotografías, es el volumen entero:

```bash
docker run --rm -v cdhquartz_cdh-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/cdh-$(date +%F).tar.gz -C /data .
```

## Puesta en producción en una máquina propia

Con HTTPS automático, en una VM de cualquier proveedor (sirve una gratuita como
las **Always Free** de Oracle Cloud; la imagen es multiarquitectura y corre
igual en ARM).

**Antes de empezar** necesita un dominio —o un subdominio— apuntando por DNS a
la IP pública de la máquina. Sin dominio no hay certificado válido, y una
aplicación con inicio de sesión no debe ir por HTTP.

```bash
# 1. Docker en la máquina (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && newgrp docker

# 2. El proyecto
sudo mkdir -p /opt/cdh && sudo chown "$USER" /opt/cdh
git clone https://github.com/AmezolaCD/CDHQuartz.git /opt/cdh && cd /opt/cdh

# 3. Configuración
cp .env.example .env
#    edite .env:  CDH_SEED_PASSWORD, CDH_TZ, CDH_DOMAIN

# 4. Arranque, con el proxy de HTTPS delante
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build

# 5. Comprobación
docker compose ps                       # ambos servicios "healthy"
curl -sI https://$CDH_DOMAIN/api/health # 200
```

Caddy pide el certificado a Let's Encrypt y lo renueva solo. Sólo él queda
expuesto: el CDH sigue publicado en `127.0.0.1`, alcanzable desde Caddy por la
red interna de Docker.

**Los puertos 80 y 443 deben estar abiertos en los dos sitios.** En Oracle
Cloud no basta con la lista de seguridad de la red: la imagen trae además
reglas locales que descartan el tráfico, y hay que abrirlas dentro de la
máquina.

```bash
sudo iptables -I INPUT -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save      # que sobrevivan al reinicio
```

Actualizar a una versión nueva:

```bash
cd /opt/cdh && git pull
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build
docker compose exec cdh npm run upgrade   # pone al día el catálogo
```

## Acceso privado con Tailscale

Alternativa a la anterior para **usar un equipo propio —incluso una laptop—
como servidor**, sin dominio, sin IP fija y sin abrir un solo puerto. Tailscale
crea una red privada entre los equipos del hotel; el CDH queda accesible con
HTTPS válido **sólo para los dispositivos de esa red**, nunca desde internet.

Aquí **no** se usa `docker-compose.caddy.yml`: el HTTPS lo pone Tailscale.

```bash
# 1. En el equipo servidor: instale Tailscale (tailscale.com/download) e
#    inicie sesión. En la consola (login.tailscale.com), sección DNS, active
#    MagicDNS y HTTPS Certificates: sin eso no puede emitir el certificado.

# 2. Levante el CDH. CDH_BIND se queda en 127.0.0.1: el servicio no debe
#    asomarse ni a la red Wi-Fi local.
cp .env.example .env          # defina CDH_SEED_PASSWORD y CDH_TZ
docker compose up -d --build

# 3. Publíquelo en la red privada. La configuración persiste entre reinicios.
tailscale serve --bg 3000
tailscale serve status        # devuelve https://<equipo>.<tailnet>.ts.net
```

Compruebe que la cookie de sesión viaja marcada como segura — es lo que delata
un proxy mal puesto:

```bash
curl -s -D - -o /dev/null -X POST https://<equipo>.<tailnet>.ts.net/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"sistemas","password":"..."}' | grep -i set-cookie
# debe incluir: HttpOnly; Secure; SameSite=Lax
```

**Los dispositivos del personal.** No hace falta una cuenta por persona: en la
consola, *Settings → Keys → Generate auth key* (reutilizable). Cada teléfono
instala Tailscale, entra con esa clave y queda en la red. Después abren
`https://<equipo>.<tailnet>.ts.net` y lo agregan a la pantalla de inicio.

### En Windows

| Detalle | Qué hacer |
|---|---|
| Terminal | PowerShell, en la carpeta del proyecto para los comandos `docker` |
| `curl` | Escriba **`curl.exe`**: `curl` a secas es otro comando y confunde el resultado |
| `tailscale` no reconocido | Use la ruta completa: `& "C:\Program Files\Tailscale\tailscale.exe" serve --bg 3000` |
| Docker | Docker Desktop debe estar **abierto**; configúrelo para iniciar con la sesión |
| Suspensión | Energía → *Nunca* con corriente alterna, y *No hacer nada* al cerrar la tapa |

### Lo que hay que tener claro

El equipo tiene que estar **despierto, enchufado y conectado**: si se suspende,
el CDH se cae para todo el hotel. Y la base con el historial vive en ese disco,
así que el respaldo **fuera del equipo** deja de ser una buena práctica y pasa a
ser indispensable. Sirve muy bien para una prueba piloto con el personal real;
para producción permanente, use la puesta en producción de la sección anterior.

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

**Los estados son los de Arpón**, el PMS del hotel, con sus mismos nombres:
*Disponible limpio*, *Entrada nueva*, *Ocupado limpio*, *Ocupado sucio*,
*Salida*, *Discrepancia* y *Fuera de servicio*. El rack del CDH y la pantalla
de Ama de Llaves de Arpón se leen una junto a la otra sin traducir nada.

**La limpieza no lleva a un sitio fijo.** Cada estado declara en
`clean_status_id` a dónde pasa al terminar de limpiarlo: una *Ocupado sucio*
queda *Ocupado limpio* y una *Salida* queda *Disponible limpio*. Una acción con
un único destino mentiría en la mitad de los casos.

**Si el huésped estará en la habitación es un dato del REPORTE, no un estado.**
Quien reporta a Mantenimiento o a Sistemas contesta si lo encontrarán dentro, y
esa respuesta viaja con el movimiento y con la notificación. Sirve en el
momento en que se levanta el reporte —para saber con qué se van a encontrar al
subir—, no como una propiedad permanente de la habitación.

**Reincidencia por evento.** Un reporte que afecta varios campos genera varios
movimientos pero cuenta como **una** incidencia: la reincidencia agrupa por
`batch_id`, no por filas.

**No se libera una habitación con un pendiente abierto.** Mientras Mantenimiento
o Sistemas tengan algo sin cerrar en esa habitación —un reporte o un campo en
falla— no puede pasar a *Disponible* ni a *Inspeccionada*, ni desde la acción
rápida, ni cambiando el estado a mano, ni en un cambio en bloque. Limpiar,
comentar y reportar siguen siendo posibles. Qué áreas bloquean se configura por
categoría (`blocks_release`).

**Una falla retira la habitación de la venta.** Marcar un campo de Mantenimiento
o Sistemas en un valor de incidencia sobre una habitación en servicio la pasa al
estado pendiente de esa área en el mismo movimiento, con su registro en el
historial. Corregir el campo no la devuelve sola: hay que liberarla.

**Una incidencia abierta es trabajo pendiente, venga de donde venga.** Cuenta
tanto un campo en valor de incidencia (*Plomería: Falla*) como un reporte que
nadie ha cerrado. Un reporte se cierra con la acción de cierre de su área, con
«Liberar habitación», o al devolver la habitación a un estado de servicio —
nunca borrando nada.

**Cambios en bloque sin perder trazabilidad.** Aplicar una acción a varias
habitaciones a la vez no crea un movimiento compartido: cada habitación
conserva el suyo, con su historial, su auditoría y su notificación. Las N
operaciones ocurren en una sola transacción, de modo que si una falla no se
registra ninguna. El tope por lote es configurable (`bulk_max_rooms`).

---

## Modelo de datos

```
departments  roles  permissions  role_permissions  users  sessions
floors  room_types  room_statuses  rooms              ← estado actual
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
estado nuevo, si el huésped estaría en la habitación, comentario, severidad,
incidencia, fotografías y sello de tiempo.

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
| `POST` | `/rooms/bulk/movements` | Misma acción sobre varias habitaciones, en una transacción |
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
