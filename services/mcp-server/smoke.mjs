#!/usr/bin/env node
/**
 * Prueba de humo del servidor MCP, contra el stack levantado.
 *
 *   npm run build && npm run smoke
 *
 * POR QUE HACE FALTA ADEMAS DE LOS TESTS
 * --------------------------------------
 * Los tests de `format.test.ts` prueban el texto que se devuelve, que
 * es donde vive la logica. Lo que NO prueban es lo unico que puede
 * fallar al conectar esto a un cliente real: que el servidor hable el
 * protocolo, que las herramientas se anuncien, y que las credenciales
 * y el Gateway esten donde se dice.
 *
 * Esta prueba levanta el servidor como lo levantaria Claude Desktop
 * -por stdio, en un proceso aparte- y le habla con el cliente oficial
 * del SDK. Si esto pasa, conectar el cliente de verdad es cuestion de
 * pegar una configuracion.
 *
 * COMPRUEBA TAMBIEN LO QUE NO DEBE HABER
 * --------------------------------------
 * Que ninguna herramienta escriba. Es la garantia principal de este
 * servidor y la mas facil de romper sin querer anadiendo una
 * herramienta util.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ESPERADAS = ['quien_esta_dentro', 'horas_trabajadas', 'novedades_de_turno'];

let fallos = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  fallos++;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};

/**
 * Las credenciales salen del .env de la raiz si no estan en el entorno.
 *
 * Mismo criterio que la prueba de humo del sistema: leerlas de la
 * misma fuente que usan los servicios evita un falso negativo cuando
 * alguien cambia la cuenta de administracion.
 */
function credenciales() {
  const env = {};
  const ruta = join(process.cwd(), '..', '..', '.env');
  if (existsSync(ruta)) {
    for (const linea of readFileSync(ruta, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(linea);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return {
    DETECTOR_ADMIN_EMAIL:
      process.env.DETECTOR_ADMIN_EMAIL ?? env.ADMIN_BOOTSTRAP_EMAIL ?? '',
    DETECTOR_ADMIN_PASSWORD:
      process.env.DETECTOR_ADMIN_PASSWORD ?? env.ADMIN_BOOTSTRAP_PASSWORD ?? '',
    DETECTOR_API_URL: process.env.DETECTOR_API_URL ?? 'http://localhost:3000',
  };
}

const entorno = credenciales();
if (!entorno.DETECTOR_ADMIN_EMAIL || !entorno.DETECTOR_ADMIN_PASSWORD) {
  console.error(
    'Faltan las credenciales de administracion.\n' +
      'Define DETECTOR_ADMIN_EMAIL y DETECTOR_ADMIN_PASSWORD, o ten un .env\n' +
      'en la raiz con ADMIN_BOOTSTRAP_EMAIL y ADMIN_BOOTSTRAP_PASSWORD.',
  );
  process.exit(1);
}

if (!existsSync(join(process.cwd(), 'dist', 'main.js'))) {
  console.error('Falta dist/main.js. Ejecuta antes: npm run build');
  process.exit(1);
}

console.log('\n  Prueba de humo del servidor MCP');
console.log('  ' + '─'.repeat(46) + '\n');

const transporte = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/main.js'],
  env: { ...process.env, ...entorno },
  stderr: 'pipe',
});

const cliente = new Client({ name: 'smoke', version: '1.0.0' });

try {
  await cliente.connect(transporte);
  ok('el servidor arranca y habla el protocolo por stdio');

  const { tools } = await cliente.listTools();

  const nombres = tools.map((t) => t.name).sort();
  if (nombres.join(',') === [...ESPERADAS].sort().join(',')) {
    ok(`expone exactamente las tres herramientas: ${nombres.join(', ')}`);
  } else {
    bad(`herramientas inesperadas: ${nombres.join(', ')}`);
  }

  // La garantia principal: aqui no se escribe nada.
  const escriben = tools.filter((t) => t.annotations?.readOnlyHint !== true);
  if (escriben.length === 0) {
    ok('todas se anuncian como de SOLO LECTURA');
  } else {
    bad(`sin readOnlyHint: ${escriben.map((t) => t.name).join(', ')}`);
  }

  const sinDescripcion = tools.filter((t) => (t.description ?? '').length < 40);
  if (sinDescripcion.length === 0) {
    ok('todas explican qué devuelven');
  } else {
    bad(`descripción pobre: ${sinDescripcion.map((t) => t.name).join(', ')}`);
  }

  for (const [nombre, args] of [
    ['quien_esta_dentro', {}],
    ['horas_trabajadas', {}],
    ['novedades_de_turno', { solo_pendientes: true }],
    ['novedades_de_turno', { solo_pendientes: false, take: 1 }],
  ]) {
    const resultado = await cliente.callTool({ name: nombre, arguments: args });
    const texto = resultado.content.map((c) => c.text ?? '').join('\n');

    if (resultado.isError) {
      bad(`${nombre} ${JSON.stringify(args)} devolvió error: ${texto.slice(0, 120)}`);
    } else if (texto.trim().length === 0) {
      bad(`${nombre} ${JSON.stringify(args)} devolvió texto vacío`);
    } else {
      ok(`${nombre} ${JSON.stringify(args)} → ${texto.split('\n')[0].slice(0, 70)}`);
    }
  }

  // Un argumento invalido tiene que rechazarse, no colarse hasta el
  // Gateway: el esquema de entrada esta para eso.
  const malo = await cliente
    .callTool({ name: 'quien_esta_dentro', arguments: { siteId: 'no-es-un-uuid' } })
    .catch(() => ({ isError: true }));
  if (malo.isError) {
    ok('un argumento inválido se rechaza');
  } else {
    bad('un siteId que no es UUID se aceptó');
  }
} catch (error) {
  bad(`no se pudo completar: ${error.message}`);
} finally {
  await cliente.close().catch(() => undefined);
}

console.log('\n  ' + '─'.repeat(46));
console.log(
  fallos === 0
    ? '  \x1b[32mTodo en verde.\x1b[0m\n'
    : `  \x1b[31m${fallos} comprobación(es) fallida(s).\x1b[0m\n`,
);
process.exit(fallos > 0 ? 1 : 0);
