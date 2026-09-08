#!/usr/bin/env node
/**
 * Asigna un rol a una persona registrada.
 *
 * Existe porque la asignación de roles todavía no tiene interfaz, y sin
 * rol nadie puede entrar: una persona recién creada queda reconocida
 * pero no autorizada.
 *
 *   node scripts/assign-role.mjs                          → lista todo
 *   node scripts/assign-role.mjs "Diego" Empleado         → asigna
 *   node scripts/assign-role.mjs "Diego" Empleado --quitar
 *
 * Lee las credenciales de administración del .env del proyecto.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

function readEnvFile() {
  const path = join(process.cwd(), '.env');
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

const env = readEnvFile();
const args = process.argv.slice(2);
const revoke = args.includes('--quitar');
const [personQuery, roleQuery] = args.filter((a) => !a.startsWith('--'));

const email = env.ADMIN_BOOTSTRAP_EMAIL ?? 'admin@detector.local';
const password = env.ADMIN_BOOTSTRAP_PASSWORD;

if (!password) {
  console.error('Falta ADMIN_BOOTSTRAP_PASSWORD en el .env');
  process.exit(1);
}

let token = null;

async function api(path, init = {}) {
  if (token) init.headers = { ...init.headers, Authorization: `Bearer ${token}` };
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${body?.message ?? text}`);
  }
  return body;
}

// ── Sesión ─────────────────────────────────────────────────────────
const login = await api('/admin/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
}).catch((error) => {
  console.error(`No se pudo iniciar sesión: ${error.message}`);
  console.error('¿Están los servicios levantados? docker compose ps');
  process.exit(1);
});

token = login.accessToken;

// ── Sin argumentos: mostrar el estado actual ───────────────────────
const { items: people } = await api('/admin/persons');
const { items: roles } = await api('/admin/roles');

if (!personQuery || !roleQuery) {
  console.log('\nPERSONAS REGISTRADAS');
  if (people.length === 0) {
    console.log('  (ninguna todavía)');
  }
  for (const person of people) {
    const assigned = await api(`/admin/persons/${person.id}/roles`);
    const names = assigned.items.map((a) => a.roleName).join(', ') || 'SIN ROL';
    const faces = person.enrolledFacesCount;
    console.log(
      `  ${person.fullName.padEnd(24)} rostros: ${faces}   roles: ${names}`,
    );
  }

  console.log('\nROLES DISPONIBLES');
  for (const role of roles) {
    const perms = role.permissions
      .map((p) => `${p.zone} (${p.schedule})`)
      .join(', ');
    console.log(`  ${role.name.padEnd(16)} ${perms || 'sin permisos'}`);
  }

  console.log('\nPara asignar:');
  console.log('  node scripts/assign-role.mjs "<nombre>" <rol>');
  process.exit(0);
}

// ── Asignar o retirar ──────────────────────────────────────────────
const person = people.find((p) =>
  p.fullName.toLowerCase().includes(personQuery.toLowerCase()),
);
if (!person) {
  console.error(`No encontré ninguna persona que contenga "${personQuery}"`);
  process.exit(1);
}

const role = roles.find(
  (r) => r.name.toLowerCase() === roleQuery.toLowerCase(),
);
if (!role) {
  console.error(`No existe el rol "${roleQuery}"`);
  console.error(`Disponibles: ${roles.map((r) => r.name).join(', ')}`);
  process.exit(1);
}

if (revoke) {
  await api(`/admin/persons/${person.id}/roles/${role.id}`, {
    method: 'DELETE',
  });
  console.log(`Rol "${role.name}" retirado a ${person.fullName}`);
} else {
  await api(`/admin/persons/${person.id}/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roleId: role.id }),
  });
  const perms = role.permissions
    .map((p) => `${p.zone} (${p.schedule})`)
    .join(', ');
  console.log(`Rol "${role.name}" asignado a ${person.fullName}`);
  console.log(`  Ahora puede acceder a: ${perms}`);
}
