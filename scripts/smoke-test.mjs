#!/usr/bin/env node
/**
 * Prueba de humo del sistema completo.
 *
 *   node scripts/smoke-test.mjs
 *
 * Comprueba, en orden, que:
 *   1. Todos los servicios responden.
 *   2. Se puede crear una persona.
 *   3. Se puede enrolar un rostro (usa una imagen real que le pases).
 *   4. Esa misma persona es RECONOCIDA al verificar un frame.
 *   5. Un rostro distinto NO es reconocido.
 *   6. Se puede eliminar a la persona y sus vectores desaparecen.
 *
 * Uso:
 *   node scripts/smoke-test.mjs --enroll fotos/diego1.jpg \
 *                               --verify fotos/diego2.jpg \
 *                               --stranger fotos/otra_persona.jpg
 *
 * Si no pasas imágenes, solo ejecuta las comprobaciones 1 y 2.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * Lee credenciales del .env del proyecto.
 *
 * Antes el script llevaba el correo escrito a fuego, y en cuanto se
 * cambio la cuenta de administracion empezo a fallar el login mientras
 * el sistema funcionaba perfectamente. Leerlo de la misma fuente que
 * usan los servicios evita ese falso negativo.
 */
function readEnvFile() {
  const path = join(process.cwd(), '.env');
  if (!existsSync(path)) return {};
  const out = {};
  // Se parte con \r?\n porque en Windows el .env suele tener CRLF y, si
  // no, cada valor arrastraria un retorno de carro invisible al final.
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

const env = readEnvFile();

const enrollImage = arg('enroll');
const adminEmail =
  arg('email') ??
  process.env.ADMIN_BOOTSTRAP_EMAIL ??
  env.ADMIN_BOOTSTRAP_EMAIL ??
  'admin@detector.local';
const adminPassword =
  arg('password') ??
  process.env.ADMIN_BOOTSTRAP_PASSWORD ??
  env.ADMIN_BOOTSTRAP_PASSWORD;

/**
 * Puerta por la que se simula el paso.
 *
 * Debe existir como `terminal_key` de un access_point. Sin ella el
 * sistema responde ACCESS_POINT_DISABLED, que es lo correcto: un
 * terminal no identificado no puede abrir nada.
 */
const terminalKey = arg('terminal') ?? env.VITE_TERMINAL_KEY ?? 'main-entrance';
const verifyImage = arg('verify');
const strangerImage = arg('stranger');

let passed = 0;
let failed = 0;

const ok = (msg, extra = '') => {
  passed++;
  console.log(`  \x1b[32mOK\x1b[0m    ${msg}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`);
};
const bad = (msg, extra = '') => {
  failed++;
  console.log(`  \x1b[31mFALLO\x1b[0m ${msg}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`);
};
const skip = (msg) => console.log(`  \x1b[90mSALTA ${msg}\x1b[0m`);
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// Token de administracion, se rellena tras el login.
let adminToken = null;

async function api(path, init = {}) {
  if (adminToken && path.startsWith('/admin') && !path.includes('/auth/login')) {
    init.headers = { ...init.headers, Authorization: `Bearer ${adminToken}` };
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

function imageForm(path, extra = {}) {
  const buffer = readFileSync(path);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), basename(path));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

// ── 1. Salud de los servicios ─────────────────────────────────────
section('1. Estado de los servicios');

const health = await api('/health').catch(() => null);

if (!health) {
  bad('El API Gateway no responde', `¿está levantado en ${BASE}?`);
  console.log('\n\x1b[31mNo se puede continuar sin el Gateway.\x1b[0m');
  process.exit(1);
}

if (health.ok && health.body.status === 'ok') {
  ok('API Gateway responde');
  ok('Face Service alcanzable');
  ok('Access Service alcanzable');
} else {
  bad('Algún servicio no está disponible');
  console.log('  ' + JSON.stringify(health.body, null, 2).replace(/\n/g, '\n  '));
}

// ── 2. Autenticacion de administrador ─────────────────────────────
section('2. Autenticación de administrador');

// Sin token, las rutas de administracion deben rechazar la peticion.
const unauthorized = await api('/admin/persons');
if (unauthorized.status === 401) {
  ok('Rechaza el acceso a /admin sin token (401)');
} else {
  bad('¡/admin es accesible SIN token!', `devolvió ${unauthorized.status}`);
}

// Credenciales incorrectas.
const wrongLogin = await api('/admin/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: adminEmail, password: 'contrasena-incorrecta' }),
});
if (wrongLogin.status === 401) {
  ok('Rechaza credenciales incorrectas (401)');
  if (/no existe|not found|usuario/i.test(JSON.stringify(wrongLogin.body))) {
    bad('El mensaje de error revela si la cuenta existe');
  } else {
    ok('El mensaje de error no revela si la cuenta existe');
  }
} else {
  bad('Debería rechazar una contraseña incorrecta', `devolvió ${wrongLogin.status}`);
}

if (!adminPassword) {
  skip('sin contraseña: pásala con --password o define ADMIN_BOOTSTRAP_PASSWORD en .env');
} else {
  const login = await api('/admin/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });

  if (login.ok && login.body.accessToken) {
    adminToken = login.body.accessToken;
    ok('Inicio de sesión correcto', login.body.admin?.email);

    const authorized = await api('/admin/persons');
    if (authorized.ok) ok('Con token, /admin responde correctamente');
    else bad('Con token válido, /admin sigue rechazando', `${authorized.status}`);
  } else {
    bad(
      'No se pudo iniciar sesión',
      `como ${adminEmail} — ${JSON.stringify(login.body)}`,
    );
  }
}

// ── 3. Crear persona ──────────────────────────────────────────────
section('3. Registro de persona');

const testName = `Prueba Humo ${Date.now()}`;
const created = await api('/admin/persons', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fullName: testName }),
});

let personId = null;
if (created.status === 201 || created.status === 200) {
  personId = created.body.id;
  ok('Persona creada', personId);
} else {
  bad('No se pudo crear la persona', JSON.stringify(created.body));
}

// Validación: un nombre demasiado corto debe rechazarse.
const invalid = await api('/admin/persons', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fullName: 'x' }),
});
if (invalid.status === 400) ok('Rechaza nombres inválidos (400)');
else bad('Debería rechazar un nombre de 1 carácter', `devolvió ${invalid.status}`);

// ── 4. Enrolar rostro ─────────────────────────────────────────────
section('4. Enrolamiento facial');

if (!personId) {
  skip('sin persona creada');
} else if (!enrollImage) {
  skip('pasa --enroll ruta/a/foto.jpg para probarlo');
} else {
  const res = await api(`/admin/persons/${personId}/faces`, {
    method: 'POST',
    body: imageForm(enrollImage),
  });

  if (res.ok) {
    ok('Rostro enrolado', `calidad ${(res.body.detectionScore * 100).toFixed(0)}%`);

    // El embedding JAMAS debe aparecer en la respuesta.
    const raw = JSON.stringify(res.body);
    if (raw.includes('embedding')) {
      bad('¡La respuesta contiene un embedding! No debería salir del backend');
    } else {
      ok('La respuesta no expone el embedding');
    }
  } else {
    bad('No se pudo enrolar', JSON.stringify(res.body));
  }
}

// ── 5. Autorizacion: reconocido NO implica autorizado ─────────────
section('5. Autorización por rol y horario');

let assignedRoleId = null;

if (!personId || !enrollImage || !verifyImage) {
  skip('requiere una persona enrolada y una imagen de verificación');
} else {
  // Sin rol asignado, el sistema debe reconocer a la persona y aun asi
  // denegarle el paso. Es la diferencia entre identidad y autorizacion.
  const noRole = await api('/auth/verify-frame', {
    method: 'POST',
    body: imageForm(verifyImage, { terminalKey }),
  });

  if (noRole.ok && noRole.body.reason === 'NO_ROLE_ASSIGNED') {
    ok('Sin rol asignado, deniega aunque reconozca el rostro');
    if (noRole.body.faces?.[0]?.recognized) {
      ok('La caja sigue en verde: se le reconoció, no se le autorizó');
    }
  } else {
    bad(
      'Debería denegar por falta de rol',
      `motivo ${noRole.body?.reason}`,
    );
  }

  // Se asigna "Seguridad" y no "Empleado" a proposito: su horario es
  // 24/7, asi que la prueba no depende de la hora a la que se ejecute.
  const roles = await api('/admin/roles');
  const securityRole = roles.body?.items?.find((r) => r.name === 'Seguridad');

  if (!securityRole) {
    bad('No se encontró el rol "Seguridad"', 'ejecuta el seed del access-service');
  } else {
    assignedRoleId = securityRole.id;
    const assigned = await api(`/admin/persons/${personId}/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: securityRole.id }),
    });
    if (assigned.ok) ok('Rol asignado', securityRole.name);
    else bad('No se pudo asignar el rol', JSON.stringify(assigned.body));
  }
}

// ── 6. Reconocer y conceder ───────────────────────────────────────
section('6. Reconocimiento');

if (!personId || !enrollImage) {
  skip('requiere una persona enrolada');
} else if (!verifyImage) {
  skip('pasa --verify ruta/a/otra_foto.jpg (misma persona)');
} else {
  // Se envían varios frames porque el acceso exige votación multi-frame.
  let sessionKey;
  let granted = false;
  let lastConfidence = 0;
  let recognizedName = null;
  let faceAccessToken = null;

  for (let i = 0; i < 6 && !granted; i++) {
    const res = await api('/auth/verify-frame', {
      method: 'POST',
      body: imageForm(verifyImage, {
        terminalKey,
        ...(sessionKey ? { sessionKey } : {}),
      }),
    });

    if (!res.ok) {
      bad('verify-frame falló', JSON.stringify(res.body));
      break;
    }

    sessionKey = res.body.sessionKey;
    lastConfidence = res.body.confidence;
    if (res.body.accessToken) faceAccessToken = res.body.accessToken;
    if (res.body.faces?.[0]?.personName) recognizedName = res.body.faces[0].personName;
    granted = res.body.authenticated;

    if (i === 0) {
      if (res.body.faces?.length) ok('Rostro detectado en el frame');
      else bad('No se detectó ningún rostro en la imagen de verificación');
    }
  }

  if (granted) {
    ok(`Acceso CONCEDIDO tras votación`, `similitud ${lastConfidence.toFixed(3)}`);
    if (recognizedName === testName) ok('Identificó a la persona correcta');
    else bad(`Identificó a "${recognizedName}" en lugar de "${testName}"`);

    // Separacion de privilegios: el token que recibe una persona al ser
    // reconocida NO debe servir para administrar el sistema. Si sirviera,
    // cualquiera con la cara registrada podria borrar a los demas.
    if (faceAccessToken) {
      const escalation = await fetch(`${BASE}/admin/persons`, {
        headers: { Authorization: `Bearer ${faceAccessToken}` },
      });
      if (escalation.status === 401) {
        ok('El token de acceso facial NO sirve para administrar');
      } else {
        bad(
          '¡ESCALADA DE PRIVILEGIOS! El token de acceso facial permite administrar',
          `devolvió ${escalation.status}`,
        );
      }
    }
  } else {
    bad('No concedió el acceso', `mejor similitud ${lastConfidence.toFixed(3)}`);
  }
}

// ── 7. Rechazar a un desconocido ──────────────────────────────────
section('7. Rechazo de desconocido');

if (!strangerImage) {
  skip('pasa --stranger ruta/a/otra_persona.jpg');
} else {
  const res = await api('/auth/verify-frame', {
    method: 'POST',
    body: imageForm(strangerImage, { terminalKey }),
  });

  if (!res.ok) {
    bad('verify-frame falló', JSON.stringify(res.body));
  } else if (res.body.authenticated) {
    bad('¡FALSO POSITIVO! Concedió acceso a un desconocido', `similitud ${res.body.confidence}`);
  } else {
    ok('Acceso denegado correctamente', `motivo ${res.body.reason}, similitud ${res.body.confidence.toFixed(3)}`);
  }
}

// ── 8. Borrado ────────────────────────────────────────────────────
section('8. Eliminación y derecho al olvido');

if (!personId) {
  skip('sin persona creada');
} else {
  const res = await api(`/admin/persons/${personId}`, { method: 'DELETE' });
  if (res.ok) {
    ok('Persona eliminada', `${res.body.deletedEmbeddings} vector(es) borrados`);

    const after = await api(`/admin/persons/${personId}`);
    if (after.status === 404) ok('Ya no aparece en consultas');
    else bad('Sigue siendo consultable tras el borrado');
  } else {
    bad('No se pudo eliminar', JSON.stringify(res.body));
  }
}

// ── Resumen ───────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`  \x1b[32m${passed} correctas\x1b[0m   \x1b[31m${failed} fallidas\x1b[0m`);
console.log('─'.repeat(52));

process.exit(failed > 0 ? 1 : 0);
