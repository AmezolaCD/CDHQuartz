# ============================================================================
# CDH — Control de Detalles por Habitación | Hotel Quartz
#
# better-sqlite3 publica sus binarios DENTRO del paquete (prebuilds/), uno por
# plataforma, incluidos linuxmusl-x64 y linuxmusl-arm64. Pero el paquete también
# publica su binding.gyp, y eso hace que npm lance `node-gyp rebuild` por su
# cuenta: sin --ignore-scripts la imagen exige python y un compilador, y la
# construcción falla en Alpine. Con la bandera, el módulo carga el binario que
# ya trae y la imagen final no lleva gcc, python ni node-gyp.
# ============================================================================

# ------------------------------------------------------------- dependencias
FROM node:22-alpine AS deps
WORKDIR /app
# .npmrc lleva engine-strict: si la base cambiara a un Node <22, falla aquí
# con un mensaje claro en vez de reventar en tiempo de ejecución.
COPY package.json package-lock.json .npmrc ./
# --ignore-scripts evita la compilación innecesaria. Ningún paquete del árbol
# declara un script de instalación propio, así que no se pierde nada.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Comprobación en tiempo de construcción: si el binario nativo no cargara, la
# imagen falla aquí con un mensaje claro, en vez de en el hotel al arrancar.
RUN node -e "const D=require('better-sqlite3'); new D(':memory:').exec('CREATE TABLE t(a)'); console.log('binario nativo OK');"

# ----------------------------------------------------------------- runtime
FROM node:22-alpine AS runtime

# tini como PID 1: reenvía SIGTERM y recoge procesos huérfanos, para que
# `docker stop` termine el servidor de forma ordenada.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000 \
    CDH_DATA_DIR=/app/data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

# La base SQLite y las fotografías se escriben aquí. Se crea con la propiedad
# correcta ANTES de declarar el volumen: así un volumen con nombre hereda el
# dueño y el proceso sin privilegios puede escribir desde el primer arranque.
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
VOLUME ["/app/data"]

# La imagen oficial ya trae el usuario `node` (uid 1000): nada corre como root.
USER node
EXPOSE 3000

# Node 22 trae fetch global: la comprobación no necesita curl ni wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
