// ============================================================================
// Entrada única desde Core Quartz (fase 05).
//
// El shell emite un código de un solo uso y manda al navegador aquí. El CDH lo
// canjea **por la red interna** contra el shell, con un secreto compartido, y
// sólo si el shell lo aprueba crea su propia sesión con `createSession()`.
// Nunca se comparte token de sesión entre aplicaciones: cada una termina con
// la suya.
//
// Si faltan `CQ_URL_INTERNA` o `CQ_SSO_SECRETO`, este router no se monta con
// rutas: las tres responden 404 y el CDH se comporta como siempre.
// ============================================================================
import express from 'express';
import crypto from 'node:crypto';
import {
  COOKIE_NAME, createSession, findUserByUsername, revokeAllSessions, withPermissions,
} from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { asyncRoute } from '../middleware/auth.js';

const router = express.Router();

const URL_INTERNA = (process.env.CQ_URL_INTERNA ?? '').replace(/\/+$/, '');
const SECRETO = process.env.CQ_SSO_SECRETO ?? '';

/** Sin las dos variables, la entrada única no existe. */
const ACTIVA = URL_INTERNA !== '' && SECRETO !== '';

/**
 * Cuánto se espera al shell antes de rendirse.
 *
 * Es una redirección del navegador: si el shell no contesta, más vale una
 * página que explique qué pasó que una pestaña girando sin fin.
 */
const ESPERA_MS = 4_000;

/** Compara en tiempo constante y sin delatar el largo. */
function mismoSecreto(enviado) {
  const a = crypto.createHash('sha256').update(String(enviado ?? ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(SECRETO, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

const escapar = (texto) => String(texto).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** Página de error en español, sin sesión y sin pistas de más. */
function paginaDeError(res, estado, titulo, detalle) {
  res.status(estado).type('html').send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapar(titulo)} — CDH</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; display: grid; place-items: center;
         min-height: 100vh; background: #f4f1f5; color: #2b2430; padding: 24px; }
  main { max-width: 34rem; background: #fff; border-radius: 14px; padding: 28px 30px;
         box-shadow: 0 10px 30px rgba(0,0,0,.08); }
  h1 { margin: 0 0 12px; font-size: 1.3rem; color: #6b2e63; }
  p { margin: 0 0 10px; line-height: 1.5; }
</style>
</head>
<body>
  <main>
    <h1>${escapar(titulo)}</h1>
    <p>${escapar(detalle)}</p>
    <p>Vuelve a Core Quartz y abre el CDH otra vez.</p>
  </main>
</body>
</html>`);
}

/** Los motivos que devuelve el shell (R4), en español y sin tecnicismos. */
const DETALLE_POR_MOTIVO = {
  usado: 'Ese enlace ya se había usado. Cada entrada sirve una sola vez.',
  vencido: 'El enlace caducó. Son válidos apenas un minuto.',
  modulo: 'Ese enlace no era para el CDH.',
  inactivo: 'Tu acceso al CDH ya no está activo. Avísale a Sistemas.',
  desconocido: 'No reconocimos ese enlace.',
};

if (ACTIVA) {
  // -------------------------------------------------------------- Canje
  router.get('/', asyncRoute(async (req, res) => {
    const codigo = String(req.query.codigo ?? '');
    if (!codigo) {
      return paginaDeError(res, 400, 'Falta el código de entrada',
        'La dirección no traía el código que entrega Core Quartz.');
    }

    let respuesta;
    try {
      respuesta = await fetch(`${URL_INTERNA}/portal/api/sso/canjear`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cq-secreto': SECRETO },
        body: JSON.stringify({ codigo, modulo: 'cdh' }),
        signal: AbortSignal.timeout(ESPERA_MS),
      });
    } catch {
      // El shell no está: no se crea sesión y se dice con claridad.
      audit({ entityType: 'auth', entityLabel: 'sso', action: 'sso_rechazo',
        reason: 'El shell de Core Quartz no respondió.', req });
      return paginaDeError(res, 503, 'No se pudo verificar la entrada; intenta de nuevo',
        'Core Quartz no respondió a tiempo, así que no abrimos ninguna sesión.');
    }

    let datos = {};
    try { datos = await respuesta.json(); } catch { /* cuerpo vacío o no-JSON */ }

    if (!respuesta.ok) {
      const motivo = String(datos.motivo ?? 'desconocido');
      audit({ entityType: 'auth', entityLabel: 'sso', action: 'sso_rechazo',
        reason: `Core Quartz rechazó el canje (${respuesta.status} ${motivo}).`, req });
      return paginaDeError(res, 403, 'No pudimos abrir tu sesión',
        DETALLE_POR_MOTIVO[motivo] ?? 'Core Quartz no autorizó esta entrada.');
    }

    // R4, lado CDH: el usuario que nombra el shell debe existir aquí y estar activo.
    const usuarioModulo = String(datos.usuario_modulo ?? '');
    const encontrado = usuarioModulo ? findUserByUsername(usuarioModulo) : null;
    if (!encontrado || !encontrado.active) {
      audit({ entityType: 'auth', entityId: encontrado?.id ?? null, entityLabel: usuarioModulo,
        action: 'sso_rechazo', actor: encontrado ?? null,
        reason: 'Tu usuario del CDH no existe o está inactivo.', req });
      return paginaDeError(res, 403, 'Tu usuario del CDH no existe o está inactivo',
        'Entraste a Core Quartz, pero aquí no encontramos tu usuario activo. Avísale a Sistemas.');
    }

    const usuario = withPermissions(encontrado);
    const { token, expiresAt } = createSession(usuario, req);
    audit({ entityType: 'auth', entityId: usuario.id, entityLabel: usuario.username,
      action: 'sso_login', actor: usuario, after: { origen: 'core-quartz' }, req });

    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: req.app.locals.basePath || '/',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      expires: expiresAt,
    });
    // El código no viaja en la redirección: ya se gastó y no tiene por qué
    // quedar en el historial del navegador.
    res.redirect(302, `${req.app.locals.basePath || ''}/`);
  }));

  // ------------------------------------------- Consulta de usuario (R7)
  router.get('/usuario/:username', (req, res) => {
    if (!mismoSecreto(req.get('x-cq-secreto'))) return res.status(404).json({ error: 'No encontrado.' });
    const encontrado = findUserByUsername(String(req.params.username));
    res.json({ existe: !!encontrado, activo: !!encontrado?.active });
  });

  // ------------------------------------------------ Revocación (R6)
  router.post('/revocar', (req, res) => {
    if (!mismoSecreto(req.get('x-cq-secreto'))) return res.status(404).json({ error: 'No encontrado.' });
    const usuarioModulo = String(req.body?.usuario_modulo ?? '');
    const encontrado = usuarioModulo ? findUserByUsername(usuarioModulo) : null;
    if (!encontrado) return res.json({ revocadas: 0 });
    const revocadas = revokeAllSessions(encontrado.id, 'Desactivado en Core Quartz', null, req);
    res.json({ revocadas });
  });
}

export default router;
