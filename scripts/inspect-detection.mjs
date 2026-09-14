#!/usr/bin/env node
/**
 * Ensena QUE esta detectando el sistema, y con que puntuacion.
 *
 *   node scripts/inspect-detection.mjs
 *
 * Abre una pagina con la camara y dibuja encima cada caja que el
 * detector encuentra, con su puntuacion, su tamano, su nitidez y su
 * puntuacion de vida. Las que pasan el control de calidad salen en
 * verde; las que se descartan, en gris.
 *
 * PARA QUE SIRVE ESTO, EN CONCRETO
 * --------------------------------
 * Para no elegir un umbral a ojo. El 2026-09-14 el detector marcaba
 * como rostro un cuadro colgado en la pared y un torso sin cabeza, y el
 * sistema respondia MULTIPLE_FACES: la puerta no abria por culpa de la
 * decoracion. La pregunta «subo la confianza a 0.6?» no se puede
 * responder sin saber que puntuan esas cajas y que puntua una cara de
 * verdad, y eso es justo lo que esta herramienta imprime.
 *
 * Es la misma leccion que la deteccion de vida: un umbral elegido sin
 * ver la distribucion es numerologia. Aqui la distribucion se ve.
 *
 * NO GUARDA NINGUNA IMAGEN
 * ------------------------
 * A diferencia de `capture-attack-set.mjs`, este no escribe frames en
 * ningun sitio. Los manda al contenedor, lee los numeros y los tira.
 * No hace falta conservarlos y son rostros de personas.
 *
 * POR QUE PASA POR EL CONTENEDOR
 * ------------------------------
 * El Vision Service es interno y no publica puerto. El unico endpoint
 * de frames que el Gateway expone es `/auth/verify-frame`, y su
 * respuesta no trae ni la puntuacion del detector ni la calidad: trae
 * el veredicto. Para ver los numeros crudos hay que entrar.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (nombre, porDefecto) => {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : porDefecto;
};

const puerto = Number(arg('puerto', '5175'));
const cadencia = Number(arg('cadencia', '1200'));

const EJECUCION = `${Date.now().toString(36)}-${process.pid}`;
const HELPER_DESTINO = `/tmp/inspeccionar-${EJECUCION}.py`;
const HELPER = join(
  process.cwd(),
  'services',
  'vision-service',
  'scripts',
  'inspeccionar_frame.py',
);

// Los mismos parametros que el terminal real (`useCamera.ts`). Medir
// sobre una captura distinta de la que el sistema usa daria numeros que
// no valen para decidir nada.
const ANCHO_MAX = 640;
const CALIDAD = 0.75;

if (!existsSync(HELPER)) {
  console.error(`Falta el ayudante: ${HELPER}`);
  process.exit(1);
}

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

execFileSync(
  'docker',
  ['compose', 'cp', HELPER, `vision-service:${HELPER_DESTINO}`],
  { cwd: process.cwd(), stdio: 'ignore' },
);

/** Manda un JPEG al contenedor por stdin y devuelve lo que midio. */
function inspeccionar(jpeg) {
  const salida = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'vision-service', 'python', HELPER_DESTINO],
    { cwd: process.cwd(), input: jpeg, maxBuffer: 8 * 1024 * 1024 },
  );

  if (salida.status !== 0) {
    return { error: salida.stderr?.toString().trim() || 'fallo al inspeccionar' };
  }
  try {
    return JSON.parse(salida.stdout.toString());
  } catch {
    return { error: 'respuesta ilegible del contenedor' };
  }
}

let frames = 0;

function informar(datos) {
  frames += 1;
  const cajas = datos.cajas ?? [];
  const aceptadas = cajas.filter((c) => c.aceptada).length;

  const cabecera =
    `\n  frame ${String(frames).padStart(3)} · ` +
    `${cajas.length} detectada(s), ${aceptadas} aceptada(s)`;
  console.log(
    aceptadas > 1 ? `${cabecera}   <-- esto responde MULTIPLE_FACES` : cabecera,
  );

  for (const [i, c] of cajas.entries()) {
    const estado = c.aceptada ? 'ACEPTADA ' : 'descartada';
    const vida =
      c.vida === undefined || c.vida === null
        ? '    -'
        : c.vida.toFixed(3).padStart(5);
    const nitidez =
      c.nitidez === undefined ? '    -' : c.nitidez.toFixed(1).padStart(5);
    console.log(
      `    #${i + 1} ${estado}  score ${c.score.toFixed(3)}  ` +
        `${String(c.ancho).padStart(3)}x${String(c.alto).padEnd(3)} px  ` +
        `nitidez ${nitidez}  vida ${vida}`,
    );
  }
}

const PAGINA = String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Que esta detectando</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0f14; color:#e6edf3;
         font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; }
  main { max-width:1000px; margin:0 auto; padding:24px 20px 60px; }
  h1 { font-size:20px; margin:0 0 4px; }
  p.sub { margin:0 0 18px; color:#8b98a5; }
  .marco { position:relative; line-height:0; }
  video, canvas.capa { width:100%; border-radius:10px; display:block; }
  canvas.capa { position:absolute; inset:0; }
  table { width:100%; border-collapse:collapse; margin-top:18px; font-size:13px; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid #1b2430; }
  th { color:#8b98a5; font-weight:500; }
  td.n { font-variant-numeric:tabular-nums; }
  .ok { color:#3fb950; } .no { color:#8b98a5; } .mal { color:#f85149; }
  .aviso { margin-top:14px; color:#f0883e; min-height:22px; }
  .leyenda { margin-top:10px; color:#8b98a5; font-size:13px; }
</style>
</head>
<body>
<main>
  <h1>Qu&eacute; est&aacute; detectando el sistema</h1>
  <p class="sub">
    Misma c&aacute;mara y mismos par&aacute;metros que el terminal (640&nbsp;px, calidad 0.75).
    No se guarda ninguna imagen.
  </p>

  <div class="marco">
    <video id="video" playsinline muted></video>
    <canvas id="capa" class="capa"></canvas>
  </div>

  <p class="leyenda">
    <span class="ok">&#9632; verde</span>: pasa el control de calidad y llega a la decisi&oacute;n.
    <span class="no">&#9632; gris</span>: el detector la vio y el filtro la descart&oacute;.
  </p>

  <table>
    <thead>
      <tr><th>#</th><th>estado</th><th>score</th><th>tama&ntilde;o</th>
          <th>nitidez</th><th>vida</th></tr>
    </thead>
    <tbody id="tabla"><tr><td colspan="6" class="no">esperando&hellip;</td></tr></tbody>
  </table>

  <p class="aviso" id="aviso"></p>
</main>

<script>
const CONFIG = __CONFIG__;
const video = document.getElementById('video');
const capa = document.getElementById('capa');
const tabla = document.getElementById('tabla');
const aviso = document.getElementById('aviso');
const lienzo = document.createElement('canvas');

function pintar(datos) {
  const cajas = datos.cajas || [];
  const ctx = capa.getContext('2d');
  capa.width = datos.ancho || video.videoWidth;
  capa.height = datos.alto || video.videoHeight;
  ctx.clearRect(0, 0, capa.width, capa.height);
  ctx.font = '600 15px system-ui, sans-serif';
  ctx.textBaseline = 'top';

  cajas.forEach((c, i) => {
    const color = c.aceptada ? '#3fb950' : '#6b7785';
    ctx.strokeStyle = color;
    ctx.lineWidth = c.aceptada ? 3 : 2;
    if (!c.aceptada) ctx.setLineDash([7, 5]); else ctx.setLineDash([]);
    ctx.strokeRect(c.bbox.x, c.bbox.y, c.bbox.width, c.bbox.height);

    const etiqueta = '#' + (i + 1) + '  ' + c.score.toFixed(2);
    const ancho = ctx.measureText(etiqueta).width + 12;
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.fillRect(c.bbox.x, Math.max(0, c.bbox.y - 22), ancho, 22);
    ctx.fillStyle = '#0b0f14';
    ctx.fillText(etiqueta, c.bbox.x + 6, Math.max(0, c.bbox.y - 21));
  });

  const aceptadas = cajas.filter((c) => c.aceptada).length;
  aviso.textContent = aceptadas > 1
    ? 'Con ' + aceptadas + ' caras aceptadas, el sistema responde MULTIPLE_FACES y no abre.'
    : '';

  tabla.innerHTML = cajas.length === 0
    ? '<tr><td colspan="6" class="no">sin detecciones</td></tr>'
    : cajas.map((c, i) =>
        '<tr><td class="n">' + (i + 1) + '</td>' +
        '<td class="' + (c.aceptada ? 'ok' : 'no') + '">' +
          (c.aceptada ? 'aceptada' : 'descartada') + '</td>' +
        '<td class="n">' + c.score.toFixed(3) + '</td>' +
        '<td class="n">' + c.ancho + '&times;' + c.alto + '</td>' +
        '<td class="n">' + (c.nitidez === undefined ? '-' : c.nitidez.toFixed(1)) + '</td>' +
        '<td class="n">' + (c.vida === undefined || c.vida === null ? '-' : c.vida.toFixed(3)) + '</td>' +
        '</tr>'
      ).join('');
}

async function ciclo() {
  if (video.videoWidth) {
    const escala = Math.min(1, CONFIG.anchoMax / video.videoWidth);
    lienzo.width = Math.round(video.videoWidth * escala);
    lienzo.height = Math.round(video.videoHeight * escala);
    lienzo.getContext('2d').drawImage(video, 0, 0, lienzo.width, lienzo.height);

    const blob = await new Promise((r) =>
      lienzo.toBlob(r, 'image/jpeg', CONFIG.calidad));

    try {
      const res = await fetch('/frame', { method: 'POST', body: blob });
      const datos = await res.json();
      if (datos.error) aviso.textContent = datos.error;
      else pintar(datos);
    } catch (e) {
      aviso.textContent = String(e);
    }
  }
  setTimeout(ciclo, CONFIG.cadencia);
}

navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 } } })
  .then((s) => { video.srcObject = s; return video.play(); })
  .then(ciclo)
  .catch((e) => { aviso.textContent = 'No se pudo abrir la camara: ' + e.message; });
</script>
</body>
</html>`;

const servidor = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/frame') {
    const trozos = [];
    for await (const trozo of req) trozos.push(trozo);
    const datos = inspeccionar(Buffer.concat(trozos));
    if (!datos.error) informar(datos);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(datos));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    PAGINA.replace(
      '__CONFIG__',
      JSON.stringify({ anchoMax: ANCHO_MAX, calidad: CALIDAD, cadencia }),
    ),
  );
});

servidor.listen(puerto, '127.0.0.1', () => {
  console.log('\n  Inspector de detecciones');
  console.log('  ' + '─'.repeat(66));
  console.log(`\n  Abre  http://localhost:${puerto}\n`);
  console.log('  Apunta la camara a lo que te esta dando problemas: el cuadro');
  console.log('  de la pared, un torso sin cabeza, una foto. La tabla dice que');
  console.log('  puntuacion saca cada cosa, y con eso se elige el umbral.\n');
  console.log('  Ctrl+C para salir.');
});

function limpiar() {
  try {
    execFileSync(
      'docker',
      ['compose', 'exec', '-T', '-u', 'root', 'vision-service', 'rm', '-f', HELPER_DESTINO],
      { cwd: process.cwd(), stdio: 'ignore' },
    );
  } catch {
    // Nada que borrar.
  }
}

process.on('SIGINT', () => {
  limpiar();
  console.log('\n');
  process.exit(0);
});
