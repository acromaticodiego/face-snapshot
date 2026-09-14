#!/usr/bin/env node
/**
 * Mide la deteccion de vida contra el conjunto de ataque.
 *
 *   node scripts/measure-liveness.mjs
 *
 * Es la segunda mitad de `capture-attack-set.mjs`: aquel graba, este
 * responde. Y responde UNA sola pregunta:
 *
 *     ¿existe algun umbral sobre las senales actuales que separe una
 *     cara real de una foto en la pantalla de un movil?
 *
 * Si la respuesta es que no, no hay nada que calibrar: la senal se
 * sustituye. Eso ya se sospechaba con siete frames sueltos medidos el
 * 2026-09-13 -apuntaban al reves-, y esto es lo mismo con un conjunto
 * de verdad.
 *
 * POR QUE PASA POR EL CONTENEDOR
 * ------------------------------
 * El Vision Service es interno y no publica puerto: solo el Face
 * Service lo llama. Este script copia el conjunto dentro y ejecuta
 * `scripts/medir_vida.py` alli, que habla con el servicio por
 * localhost y reutiliza los modelos YA CARGADOS. Cargarlos otra vez
 * costaria medio minuto para nada.
 *
 * LAS IMAGENES NO SALEN DE LA MAQUINA
 * -----------------------------------
 * Se copian a un contenedor local y se borran al terminar. Son rostros
 * de personas concretas; el conjunto vive en `datasets/`, que el
 * .gitignore excluye entero, y no tiene por que estar en ningun otro
 * sitio.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIRECTORIO = join(process.cwd(), 'datasets', 'liveness');

/**
 * Ruta UNICA por ejecucion dentro del contenedor.
 *
 * Con una ruta fija, dos medidas a la vez se pisan: la que termina
 * primero borra el conjunto en su limpieza y la otra se cae a mitad con
 * un «No such file or directory» sobre una imagen que acababa de
 * listar. Paso de verdad, con dos terminales abiertos.
 *
 * No es un caso rebuscado: medir tarda un par de minutos, y lo natural
 * mientras tanto es abrir otra ventana y probar algo.
 */
const EJECUCION = `${Date.now().toString(36)}-${process.pid}`;
const DESTINO = `/tmp/vida-${EJECUCION}`;

/**
 * El medidor viaja con los datos, en vez de confiar en que este en la
 * imagen.
 *
 * Esta en `services/vision-service/scripts/` y el Dockerfile lo copia,
 * asi que en una imagen recien construida ya estaria. Pero es un script
 * de ANALISIS: se toca, se vuelve a correr y se vuelve a tocar, y
 * obligar a reconstruir una imagen de 1.2 GB con torch dentro entre
 * iteracion e iteracion convertiria diez minutos de trabajo en una
 * tarde.
 *
 * Llevandolo siempre se mide con la version del arbol de trabajo, que
 * es justo lo que se quiere mientras se investiga.
 */
const MEDIDOR = join(
  process.cwd(),
  'services',
  'vision-service',
  'scripts',
  'medir_vida.py',
);
const MEDIDOR_DESTINO = `/tmp/medir-${EJECUCION}.py`;
const CLASES = ['real', 'pantalla'];

function contar(clase, variante) {
  const carpeta = join(DIRECTORIO, clase, variante);
  if (!existsSync(carpeta)) return 0;
  return readdirSync(carpeta).filter((f) => f.endsWith('.jpg')).length;
}

// ── Que haya algo que medir ───────────────────────────────────────
if (!existsSync(DIRECTORIO)) {
  console.error(
    [
      'No hay conjunto que medir.',
      '',
      'Grabalo primero:',
      '  node scripts/capture-attack-set.mjs',
      '',
      'Hacen falta las DOS clases: tu cara, y una foto de tu cara en la',
      'pantalla de un movil, con la misma camara y en la misma sesion.',
    ].join('\n'),
  );
  process.exit(1);
}

const conteo = Object.fromEntries(
  CLASES.map((clase) => [clase, contar(clase, 'terminal')]),
);

console.log('\n  Medida de la deteccion de vida');
console.log('  ' + '─'.repeat(66));
console.log(
  `\n  Conjunto: ${conteo.real} caras reales, ${conteo.pantalla} de pantalla\n`,
);

if (conteo.real === 0 || conteo.pantalla === 0) {
  console.error(
    'Falta una de las dos clases. Con una sola no hay nada que comparar.',
  );
  process.exit(1);
}

// Se avisa pero no se impide: un conjunto pequeno sirve para DESCARTAR
// una senal -si no separa con 8, no va a separar con 40- aunque no
// sirva para validarla.
if (conteo.real < 15 || conteo.pantalla < 15) {
  console.log(
    '  Aviso: con menos de 15 por clase esto sirve para descartar una\n' +
      '  senal, no para dar una por buena.\n',
  );
}

if (!existsSync(MEDIDOR)) {
  console.error(`Falta el medidor: ${MEDIDOR}`);
  process.exit(1);
}

// ── Que el servicio este en pie ───────────────────────────────────
const sano = spawnSync(
  'docker',
  ['compose', 'exec', '-T', 'vision-service', 'true'],
  { cwd: process.cwd() },
);

if (sano.status !== 0) {
  console.error(
    'El Vision Service no responde. Levanta el stack:\n  docker compose up -d',
  );
  process.exit(1);
}

// ── Copiar, medir, limpiar ────────────────────────────────────────
const docker = (args, opciones = {}) =>
  execFileSync('docker', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...opciones,
  });

try {
  docker(['compose', 'cp', DIRECTORIO, `vision-service:${DESTINO}`], {
    stdio: 'ignore',
  });
  docker(['compose', 'cp', MEDIDOR, `vision-service:${MEDIDOR_DESTINO}`], {
    stdio: 'ignore',
  });

  const salida = docker(
    [
      'compose',
      'exec',
      '-T',
      'vision-service',
      'python',
      MEDIDOR_DESTINO,
      DESTINO,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );

  console.log(salida);
} catch (error) {
  // Un veredicto negativo sale con codigo 1 y su informe ya impreso:
  // no es un fallo del script, es la respuesta.
  if (error.stdout) console.log(error.stdout);
  if (error.status !== 1) {
    console.error('\nNo se pudo completar la medida.');
    console.error(error.stderr ?? error.message);
    process.exit(1);
  }
  process.exitCode = 1;
} finally {
  limpiar();
}

/**
 * Borra lo copiado, COMO ROOT.
 *
 * `docker compose cp` escribe dentro del contenedor como root, y el
 * Vision Service corre con un usuario sin privilegios: un `rm` normal
 * falla con «Permission denied» y deja los archivos puestos.
 *
 * Eso no seria solo suciedad: `cp` sobre un directorio que ya existe lo
 * ANIDA dentro, asi que basura de una pasada anterior se acabaria
 * midiendo. Con la ruta unica por ejecucion eso ya no puede pasar, pero
 * sin limpiar se irian acumulando conjuntos de rostros dentro del
 * contenedor, que es justo lo que este proyecto evita en todas partes.
 */
function limpiar() {
  try {
    docker(
      [
        'compose', 'exec', '-T', '-u', 'root', 'vision-service',
        'rm', '-rf', DESTINO, MEDIDOR_DESTINO,
      ],
      { stdio: 'ignore' },
    );
  } catch {
    // No habia nada que borrar, que es el caso normal en la primera
    // pasada.
  }
}
