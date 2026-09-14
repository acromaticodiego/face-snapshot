#!/usr/bin/env node
/**
 * Genera el certificado con el que servir la interfaz por HTTPS.
 *
 *   node scripts/generate-tls-cert.mjs
 *
 * POR QUE HACE FALTA HTTPS, Y NO ES POR ADORNO
 * --------------------------------------------
 * La camara del navegador solo funciona en un CONTEXTO SEGURO.
 * `localhost` cuenta como tal por una excepcion de la especificacion,
 * asi que en la maquina que corre Docker todo va. Desde cualquier otra
 * -un movil, el portatil de al lado- la direccion ya no es localhost, y
 * el navegador se NIEGA a abrir la camara.
 *
 * Es decir: sin esto, el sistema entero solo se puede enseñar sentado
 * delante del equipo que lo ejecuta.
 *
 * QUE ENTRA EN EL CERTIFICADO, Y POR QUE IMPORTA
 * ----------------------------------------------
 * Los navegadores llevan desde 2017 ignorando el Common Name: lo unico
 * que miran es el subjectAltName. Un certificado sin SAN para la IP
 * concreta por la que entras da un error que NO se puede saltar con el
 * boton de «continuar de todos modos».
 *
 * Por eso aqui se meten todas las direcciones IPv4 de la maquina, no
 * una: cual es «la buena» depende de por que interfaz venga el movil, y
 * generar el certificado equivocado se descubre con el telefono en la
 * mano y el navegador negandose.
 *
 * ES AUTOFIRMADO, Y ESO TIENE CONSECUENCIAS
 * -----------------------------------------
 * El navegador avisara la primera vez y hay que aceptar la excepcion.
 * Una vez aceptada, el origen cuenta como seguro y la camara funciona.
 * Para un despliegue de verdad esto se sustituye por un certificado de
 * una autoridad reconocida; lo que no cambia es el resto del montaje.
 *
 * NO VA AL REPOSITORIO. La clave privada se queda en
 * `infrastructure/tls/`, que el .gitignore excluye. Subir una clave
 * privada a git es de las pocas cosas que no tienen arreglo
 * despues: hay que rotarla, no borrarla del historial.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { join } from 'node:path';

const DESTINO = join(process.cwd(), 'infrastructure', 'tls');
const CLAVE = join(DESTINO, 'servidor.key');
const CERTIFICADO = join(DESTINO, 'servidor.crt');
const CONFIG = join(DESTINO, 'openssl.cnf');

const DIAS = 825; // El maximo que aceptan los navegadores modernos.

const args = process.argv.slice(2);
const forzar = args.includes('--forzar');

// ── Que openssl este a mano ───────────────────────────────────────
const version = spawnSync('openssl', ['version'], { encoding: 'utf8' });
if (version.status !== 0) {
  console.error(
    [
      'No se encontro `openssl`.',
      '',
      'En Windows viene con Git: prueba desde Git Bash, o anade',
      '  C:\\Program Files\\Git\\usr\\bin',
      'al PATH de PowerShell.',
    ].join('\n'),
  );
  process.exit(1);
}

if (existsSync(CERTIFICADO) && !forzar) {
  console.log(
    [
      '',
      `  Ya existe un certificado en ${DESTINO}`,
      '',
      '  Para rehacerlo -por ejemplo si cambio la IP de la maquina-:',
      '    node scripts/generate-tls-cert.mjs --forzar',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

// ── Las direcciones por las que se va a entrar ────────────────────
const direcciones = [];
for (const interfaces of Object.values(networkInterfaces())) {
  for (const dir of interfaces ?? []) {
    if (dir.family === 'IPv4' && !dir.internal) direcciones.push(dir.address);
  }
}

const nombres = ['localhost', hostname()];
const ips = ['127.0.0.1', ...direcciones];

mkdirSync(DESTINO, { recursive: true });

const alt = [
  ...nombres.map((n, i) => `DNS.${i + 1} = ${n}`),
  ...ips.map((ip, i) => `IP.${i + 1} = ${ip}`),
].join('\n');

writeFileSync(
  CONFIG,
  `[req]
distinguished_name = dn
x509_extensions = v3
prompt = no

[dn]
CN = detector-acceso

[v3]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt

[alt]
${alt}
`,
  'utf8',
);

execFileSync(
  'openssl',
  [
    'req', '-x509',
    '-newkey', 'rsa:2048',
    '-nodes',
    '-keyout', CLAVE,
    '-out', CERTIFICADO,
    '-days', String(DIAS),
    '-config', CONFIG,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

console.log('\n  Certificado TLS generado');
console.log('  ' + '─'.repeat(66));
console.log(`\n  ${CERTIFICADO}`);
console.log(`  ${CLAVE}   <- NO subir a git\n`);
console.log('  Vale para:');
for (const n of nombres) console.log(`    ${n}`);
for (const ip of ips) console.log(`    ${ip}`);
console.log('\n  Levanta el stack con TLS:');
console.log('    docker compose -f docker-compose.yml -f docker-compose.https.yml up -d frontend\n');
console.log('  Y abre  https://<una de esas direcciones>');
console.log('  El navegador avisara del certificado: acepta la excepcion una');
console.log('  vez y la camara funcionara desde ese dispositivo.\n');
