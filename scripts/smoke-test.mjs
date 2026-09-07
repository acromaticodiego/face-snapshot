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

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const enrollImage = arg('enroll');
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

async function api(path, init) {
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

// ── 2. Crear persona ──────────────────────────────────────────────
section('2. Registro de persona');

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

// ── 3. Enrolar rostro ─────────────────────────────────────────────
section('3. Enrolamiento facial');

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

// ── 4. Reconocer a la persona ─────────────────────────────────────
section('4. Reconocimiento');

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

  for (let i = 0; i < 6 && !granted; i++) {
    const res = await api('/auth/verify-frame', {
      method: 'POST',
      body: imageForm(verifyImage, sessionKey ? { sessionKey } : {}),
    });

    if (!res.ok) {
      bad('verify-frame falló', JSON.stringify(res.body));
      break;
    }

    sessionKey = res.body.sessionKey;
    lastConfidence = res.body.confidence;
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
  } else {
    bad('No concedió el acceso', `mejor similitud ${lastConfidence.toFixed(3)}`);
  }
}

// ── 5. Rechazar a un desconocido ──────────────────────────────────
section('5. Rechazo de desconocido');

if (!strangerImage) {
  skip('pasa --stranger ruta/a/otra_persona.jpg');
} else {
  const res = await api('/auth/verify-frame', {
    method: 'POST',
    body: imageForm(strangerImage),
  });

  if (!res.ok) {
    bad('verify-frame falló', JSON.stringify(res.body));
  } else if (res.body.authenticated) {
    bad('¡FALSO POSITIVO! Concedió acceso a un desconocido', `similitud ${res.body.confidence}`);
  } else {
    ok('Acceso denegado correctamente', `motivo ${res.body.reason}, similitud ${res.body.confidence.toFixed(3)}`);
  }
}

// ── 6. Borrado ────────────────────────────────────────────────────
section('6. Eliminación y derecho al olvido');

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
