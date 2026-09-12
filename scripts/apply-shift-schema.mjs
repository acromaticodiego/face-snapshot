#!/usr/bin/env node
/**
 * Crea el schema y el rol del Shift Service en una base de datos que
 * ya existe.
 *
 *   node scripts/apply-shift-schema.mjs
 *
 * POR QUE HACE FALTA ESTE SCRIPT
 * ------------------------------
 * Los archivos de `infrastructure/postgres/init/` solo los ejecuta
 * PostgreSQL **al crear el volumen de datos**. Quien ya tenga el
 * proyecto en marcha nunca vería `02-shift.sql`, y la alternativa
 * —`docker compose down -v`— borra los rostros ya enrolados.
 *
 * Este script aplica ese mismo archivo, que es idempotente, sobre el
 * contenedor en marcha y como superusuario, que es quien puede crear
 * schemas y roles. Después hay que aplicar las migraciones:
 *
 *   cd services/shift-service && npx prisma migrate deploy
 *
 * Es un paso manual y consciente a propósito: crear roles de base de
 * datos no es algo que deba pasar solo en el arranque de un servicio.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
const container = process.env.POSTGRES_CONTAINER ?? 'detector-postgres';
const user = env.POSTGRES_USER ?? 'facedetector';
const database = env.POSTGRES_DB ?? 'face_access';
const password = env.SHIFT_SVC_DB_PASSWORD;

if (!password) {
  console.error(
    'Falta SHIFT_SVC_DB_PASSWORD en el .env.\n' +
      'Genera una con: openssl rand -base64 24',
  );
  process.exit(1);
}

// La contraseña llega como opción de sesión y no interpolada en el
// SQL: así no queda escrita en el archivo versionado ni en el
// historial de comandos del contenedor.
const sql = `
SET custom.shift_svc_password = '${password.replace(/'/g, "''")}';
\\i /docker-entrypoint-initdb.d/02-shift.sql
`;

console.log(`Aplicando el schema shift_svc en ${container}…`);

try {
  const output = execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      user,
      '-d',
      database,
    ],
    { input: sql, encoding: 'utf8' },
  );
  console.log(output.trim());
  console.log('\nListo. Ahora aplica las migraciones:');
  console.log('  cd services/shift-service && npx prisma migrate deploy');
} catch (error) {
  console.error('\nNo se pudo aplicar el schema.');
  console.error(error.stdout ?? '');
  console.error(error.stderr ?? error.message);
  console.error(
    '\nComprueba que el contenedor de PostgreSQL esté arrancado:\n' +
      '  docker compose up postgres -d',
  );
  process.exit(1);
}
