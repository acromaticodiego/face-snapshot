#!/usr/bin/env node
/**
 * Captura el conjunto de ataque de presentacion.
 *
 *   node scripts/capture-attack-set.mjs
 *   node scripts/capture-attack-set.mjs --objetivo 20 --puerto 5174
 *
 * Abre una pagina en el navegador, usa la MISMA webcam y el MISMO
 * camino de captura que el terminal real, y guarda en disco dos clases
 * de imagenes: la cara de una persona viva, y una foto de esa cara en
 * la pantalla de un movil.
 *
 * POR QUE HACE FALTA ESTO
 * -----------------------
 * La deteccion de vida de la Fase 6 NO funciona: medida el 2026-09-13
 * con una cara real y un movil, las dos senales apuntan al reves -el
 * pico periodico, que existe para delatar pantallas, marco MAS ALTO con
 * la cara real-. Sustituir esa senal por otra no se puede ni intentar
 * sin un conjunto con el que medir APCER y BPCER, y siete frames
 * sueltos sacados de dos trazas no son un conjunto. Ver el ADR 0010 y
 * la seccion «LA DETECCION DE VIDA NO FUNCIONA» del HANDOFF.
 *
 * POR QUE SE CAPTURA DESDE EL NAVEGADOR Y NO CON UNA LIBRERIA
 * ----------------------------------------------------------
 * Porque el terminal captura desde el navegador. Un conjunto grabado
 * con otra ruta -otra libreria, otra resolucion, otra compresion- mide
 * una camara que este sistema no usa, y cualquier umbral que salga de
 * ahi no valdria para el despliegue. Los parametros de abajo estan
 * copiados literalmente de `frontend/src/hooks/useCamera.ts`.
 *
 * POR QUE SE GUARDAN DOS VARIANTES DE CADA DISPARO
 * -----------------------------------------------
 * `terminal` es exactamente lo que el frontend envia hoy: 640 px de
 * ancho y calidad JPEG 0.75. Es la imagen sobre la que hay que decidir,
 * porque es la unica que el sistema ve.
 *
 * `nativo` es el frame completo de la camara a calidad 0.95. No se usa
 * para decidir nada: existe porque el tiempo de una persona posando
 * delante de una camara es el recurso caro de todo esto, y si una senal
 * futura necesitara mas pixeles -es muy probable, ver abajo- habria que
 * repetir la sesion entera. Guardar el original cuesta unos megabytes.
 *
 * LO QUE YA SE SABE, Y CONDICIONA LO QUE SE PUEDA MEDIR DESPUES
 * ------------------------------------------------------------
 * El terminal reduce cada frame a 640 px de ancho antes de enviarlo, y
 * el Vision Service mide la vida sobre el recorte alineado de 112x112,
 * al que se llega con un `warpAffine` bilineal SIN filtro antialias.
 * Una rejilla de pixeles de una pantalla no sobrevive a eso: o se
 * pierde, o se pliega por aliasing a una frecuencia cualquiera. Con
 * este conjunto en la mano, la primera comprobacion que habra que hacer
 * es sobre que imagen se mide, no que umbral se pone.
 *
 * DONDE ACABAN LAS IMAGENES
 * -------------------------
 * En `datasets/liveness/`, que el .gitignore excluye ENTERO. Son
 * rostros de personas concretas: no entran al repositorio, y el script
 * se niega a arrancar si git no confirma que ese directorio esta
 * ignorado.
 */

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// ── Parametros de captura ─────────────────────────────────────────
//
// COPIADOS DE `frontend/src/hooks/useCamera.ts`. Si alli cambian, aqui
// tambien: un conjunto grabado con otros valores deja de describir lo
// que el sistema ve, y los umbrales que salgan de el no valdran.
const CAMARA_ANCHO_IDEAL = 1280;
const CAMARA_ALTO_IDEAL = 720;
const TERMINAL_ANCHO_MAX = 640;
const TERMINAL_CALIDAD = 0.75;
// El nativo no imita a nadie: se guarda lo mas fiel posible al sensor.
const NATIVO_CALIDAD = 0.95;

const CLASES = {
  real: 'Cara real',
  pantalla: 'Foto en la pantalla de un movil',
};
const VARIANTES = ['terminal', 'nativo'];

const RAIZ = process.cwd();
const DIRECTORIO = join(RAIZ, 'datasets', 'liveness');
const MANIFIESTO = join(DIRECTORIO, 'manifiesto.jsonl');

const args = process.argv.slice(2);
const arg = (nombre, porDefecto) => {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : porDefecto;
};

const objetivo = Number(arg('objetivo', '20'));
const puerto = Number(arg('puerto', '5174'));
const rafaga = Number(arg('rafaga', '5'));

if (!Number.isFinite(objetivo) || objetivo < 1) {
  console.error('--objetivo tiene que ser un numero mayor que cero.');
  process.exit(1);
}

/**
 * Se niega a escribir un rostro donde git pudiera verlo.
 *
 * No es paranoia de mas: el .gitignore de este proyecto ya ignora
 * `*.jpg` en todas partes, asi que es facil dar por hecho que el
 * conjunto esta a salvo y olvidar que el manifiesto es un `.jsonl` que
 * esa regla no cubre, y que dice quien fue capturado, cuando y con que
 * camara. Se comprueba contra git, no contra lo que el script suponga.
 */
function exigirDirectorioIgnorado() {
  const prueba = spawnSync(
    'git',
    ['check-ignore', '-q', 'datasets/liveness/manifiesto.jsonl'],
    { cwd: RAIZ },
  );

  if (prueba.status === 0) return;

  console.error(
    [
      'ABORTADO: git NO ignora datasets/liveness/manifiesto.jsonl.',
      '',
      'Este script guarda rostros de personas reales. Antes de seguir,',
      'anade /datasets/ al .gitignore, anclado a la raiz del proyecto.',
    ].join('\n'),
  );
  process.exit(1);
}

function prepararDirectorios() {
  for (const clase of Object.keys(CLASES)) {
    for (const variante of VARIANTES) {
      mkdirSync(join(DIRECTORIO, clase, variante), { recursive: true });
    }
  }
  if (!existsSync(MANIFIESTO)) writeFileSync(MANIFIESTO, '');
}

/**
 * Cuenta lo que ya hay en disco.
 *
 * Reanudar importa: nadie graba cuarenta capturas utiles de una
 * sentada, y un script que empezara de cero en cada arranque
 * sobrescribiria la sesion anterior sin avisar.
 */
function contarExistentes() {
  const conteo = {};
  for (const clase of Object.keys(CLASES)) {
    const dir = join(DIRECTORIO, clase, 'terminal');
    conteo[clase] = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith('.jpg')).length
      : 0;
  }
  return conteo;
}

exigirDirectorioIgnorado();
prepararDirectorios();

const conteo = contarExistentes();

/** El indice lo asigna SIEMPRE el servidor: el cliente no nombra archivos. */
const siguiente = { ...conteo };

function guardarDisparo(cuerpo) {
  const clase = String(cuerpo.clase);
  if (!Object.hasOwn(CLASES, clase)) throw new Error('clase desconocida');

  // PRIMERO SE VALIDA TODO, Y DESPUES SE ESCRIBE ALGO.
  //
  // La version anterior validaba dentro del mismo bucle que escribia, y
  // al probarla con un disparo al que le faltaba la variante `nativo`
  // dejo en disco un `terminal` huerfano: sin su pareja, sin linea de
  // manifiesto, y con el contador ya gastado. Un conjunto de medida con
  // archivos que no aparecen en su manifiesto es peor que uno
  // incompleto, porque el descuadre no se nota hasta que alguien
  // intenta explicar por que los numeros no salen.
  const validadas = VARIANTES.map((variante) => {
    const datos = cuerpo[variante];
    if (!datos?.jpegBase64) throw new Error(`falta la variante ${variante}`);
    const bytes = Buffer.from(datos.jpegBase64, 'base64');
    // Una cabecera JPEG empieza por FF D8. Comprobarlo evita guardar
    // como imagen lo que sea que llegue si la pagina se equivoca.
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new Error(`la variante ${variante} no es un JPEG`);
    }
    return { variante, bytes, ancho: datos.ancho, alto: datos.alto };
  });

  const indice = (siguiente[clase] += 1);
  const nombre = `${clase}-${String(indice).padStart(4, '0')}.jpg`;
  const tamanos = {};

  for (const { variante, bytes, ancho, alto } of validadas) {
    writeFileSync(join(DIRECTORIO, clase, variante, nombre), bytes);
    tamanos[variante] = { ancho, alto, bytes: bytes.length };
  }

  appendFileSync(
    MANIFIESTO,
    `${JSON.stringify({
      archivo: nombre,
      clase,
      capturadoEn: new Date().toISOString(),
      nota: String(cuerpo.nota ?? '').slice(0, 300),
      dispositivo: String(cuerpo.dispositivo ?? '').slice(0, 200),
      agente: String(cuerpo.agente ?? '').slice(0, 300),
      variantes: tamanos,
      parametros: {
        terminalAnchoMax: TERMINAL_ANCHO_MAX,
        terminalCalidad: TERMINAL_CALIDAD,
        nativoCalidad: NATIVO_CALIDAD,
      },
    })}\n`,
    'utf8',
  );

  conteo[clase] = indice;
  const faltan = Math.max(0, objetivo - indice);
  console.log(
    `  ${clase.padEnd(8)} ${String(indice).padStart(3)}/${objetivo}` +
      `  ${nombre}  (${faltan === 0 ? 'completa' : `faltan ${faltan}`})`,
  );

  return { clase, indice, conteo };
}

const PAGINA = String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conjunto de ataque - deteccion de vida</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; background: #0b0f14; color: #e6edf3;
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif;
  }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 20px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; color: #8b98a5; }
  .rejilla { display: grid; grid-template-columns: minmax(0,1fr) 320px; gap: 24px; }
  @media (max-width: 900px) { .rejilla { grid-template-columns: 1fr; } }
  video { width: 100%; border-radius: 10px; background: #000; display: block; }
  .marco { position: relative; }
  .cuenta {
    position: absolute; inset: 0; display: grid; place-items: center;
    font-size: 88px; font-weight: 700; color: #fff;
    background: rgba(0,0,0,.45); border-radius: 10px;
  }
  .cuenta[hidden] { display: none !important; }
  fieldset { border: 1px solid #243040; border-radius: 10px; margin: 0 0 16px; padding: 14px; }
  legend { padding: 0 6px; color: #8b98a5; font-size: 13px; }
  label { display: block; margin: 8px 0 4px; color: #8b98a5; font-size: 13px; }
  input[type=text] {
    width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px;
    border: 1px solid #243040; background: #111823; color: #e6edf3; font: inherit;
  }
  .clases { display: flex; gap: 8px; }
  .clases button { flex: 1; }
  button {
    padding: 10px 14px; border-radius: 8px; border: 1px solid #243040;
    background: #16202c; color: #e6edf3; font: inherit; cursor: pointer;
  }
  button:hover:not(:disabled) { background: #1d2a39; }
  button[aria-pressed=true] { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.principal { width: 100%; margin-top: 12px; background: #238636; border-color: #238636; color: #fff; }
  .barra { height: 8px; background: #16202c; border-radius: 99px; overflow: hidden; margin-top: 6px; }
  .barra span { display: block; height: 100%; background: #238636; transition: width .2s; }
  .progreso { margin-bottom: 12px; font-size: 13px; }
  .progreso b { color: #e6edf3; font-weight: 600; }
  ul.guia { margin: 8px 0 0; padding-left: 18px; color: #8b98a5; font-size: 13px; }
  ul.guia li { margin-bottom: 4px; }
  .aviso { color: #f0883e; font-size: 13px; min-height: 20px; margin-top: 10px; }
</style>
</head>
<body>
<main>
  <h1>Conjunto de ataque &mdash; detecci&oacute;n de vida</h1>
  <p class="sub">
    Misma c&aacute;mara y mismos par&aacute;metros que el terminal real.
    Las im&aacute;genes se guardan en <code>datasets/liveness/</code>, que no va al repositorio.
  </p>

  <div class="rejilla">
    <div>
      <div class="marco">
        <video id="video" playsinline muted></video>
        <div class="cuenta" id="cuenta" hidden></div>
      </div>
      <p class="aviso" id="aviso"></p>
      <fieldset>
        <legend>C&oacute;mo grabarlo para que sirva</legend>
        <ul class="guia" id="guia"></ul>
      </fieldset>
    </div>

    <div>
      <fieldset>
        <legend>Qu&eacute; est&aacute;s capturando</legend>
        <div class="clases">
          <button type="button" data-clase="real" aria-pressed="true">Cara real</button>
          <button type="button" data-clase="pantalla" aria-pressed="false">M&oacute;vil</button>
        </div>
        <label for="nota">Condiciones (va al manifiesto)</label>
        <input type="text" id="nota" placeholder="p. ej. luz de techo, 50 cm, brillo al maximo">
      </fieldset>

      <fieldset>
        <legend>Progreso</legend>
        <div class="progreso">
          <b>Cara real</b> <span id="n-real">0</span>/<span class="objetivo"></span>
          <div class="barra"><span id="b-real" style="width:0%"></span></div>
        </div>
        <div class="progreso">
          <b>M&oacute;vil</b> <span id="n-pantalla">0</span>/<span class="objetivo"></span>
          <div class="barra"><span id="b-pantalla" style="width:0%"></span></div>
        </div>
        <button type="button" class="principal" id="disparar">
          Capturar r&aacute;faga de <span class="rafaga"></span>
        </button>
        <button type="button" id="disparar-uno" style="width:100%;margin-top:8px">
          Capturar una sola
        </button>
      </fieldset>
    </div>
  </div>
</main>

<script>
const CONFIG = __CONFIG__;

const GUIAS = {
  real: [
    'Que la cara ocupe lo mismo que ocuparia al pasar por la puerta, no mas cerca.',
    'Cambia algo entre rafagas: gira un poco la cabeza, acercate, alejate, cambia la luz.',
    'Mira a la camara en la mayoria de las capturas, igual que haria cualquiera al entrar.',
    'Sin gafas de sol ni nada que tape la cara: eso ya lo rechaza el detector por otro motivo.',
  ],
  pantalla: [
    'Brillo del movil al maximo, y la foto a pantalla completa sin barras ni interfaz.',
    'Que la cara de la pantalla ocupe el encuadre igual que ocuparia tu cara real.',
    'Evita que se vea el marco del movil: si el marco delata el ataque, lo que se mide es el marco.',
    'Varia el angulo entre rafagas, pero sin llegar a reflejos que un atacante tambien evitaria.',
    'Usa una foto tuya tomada con esta misma camara: es el ataque mas facil y el mas probable.',
  ],
};

const video = document.getElementById('video');
const aviso = document.getElementById('aviso');
const cuenta = document.getElementById('cuenta');
const guia = document.getElementById('guia');
const nota = document.getElementById('nota');
const botonRafaga = document.getElementById('disparar');
const botonUno = document.getElementById('disparar-uno');

let clase = 'real';
let dispositivo = '';
let capturando = false;

for (const el of document.querySelectorAll('.objetivo')) el.textContent = CONFIG.objetivo;
for (const el of document.querySelectorAll('.rafaga')) el.textContent = CONFIG.rafaga;

function pintarGuia() {
  guia.innerHTML = '';
  for (const texto of GUIAS[clase]) {
    const li = document.createElement('li');
    li.textContent = texto;
    guia.appendChild(li);
  }
}

function pintarProgreso(conteo) {
  for (const c of ['real', 'pantalla']) {
    const n = conteo[c] ?? 0;
    document.getElementById('n-' + c).textContent = n;
    document.getElementById('b-' + c).style.width =
      Math.min(100, (n / CONFIG.objetivo) * 100) + '%';
  }
}

for (const boton of document.querySelectorAll('[data-clase]')) {
  boton.addEventListener('click', () => {
    clase = boton.dataset.clase;
    for (const otro of document.querySelectorAll('[data-clase]')) {
      otro.setAttribute('aria-pressed', String(otro === boton));
    }
    pintarGuia();
  });
}

/**
 * Copia literal de useCamera.captureFrame, con los dos tamanos.
 *
 * 'terminal' es lo que el sistema ve de verdad; 'nativo', lo que la
 * camara entrego. Se sacan del MISMO fotograma, no de dos instantes
 * distintos: si no, no serian la misma captura vista de dos formas.
 */
function extraer(anchoMax, calidad) {
  const escala = Math.min(1, anchoMax / video.videoWidth);
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.round(video.videoWidth * escala);
  lienzo.height = Math.round(video.videoHeight * escala);
  lienzo.getContext('2d').drawImage(video, 0, 0, lienzo.width, lienzo.height);
  return {
    ancho: lienzo.width,
    alto: lienzo.height,
    jpegBase64: lienzo.toDataURL('image/jpeg', calidad).split(',')[1],
  };
}

async function disparar() {
  if (video.readyState < 2) throw new Error('la camara todavia no da imagen');
  const cuerpo = {
    clase,
    nota: nota.value,
    dispositivo,
    agente: navigator.userAgent,
    terminal: extraer(CONFIG.terminalAnchoMax, CONFIG.terminalCalidad),
    nativo: extraer(Number.MAX_SAFE_INTEGER, CONFIG.nativoCalidad),
  };

  const respuesta = await fetch('/api/disparo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  if (!respuesta.ok) throw new Error(await respuesta.text());
  pintarProgreso((await respuesta.json()).conteo);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function cuentaAtras(segundos) {
  cuenta.hidden = false;
  for (let n = segundos; n > 0; n--) {
    cuenta.textContent = String(n);
    await esperar(1000);
  }
  cuenta.hidden = true;
}

async function secuencia(cuantas) {
  if (capturando) return;
  capturando = true;
  botonRafaga.disabled = true;
  botonUno.disabled = true;
  aviso.textContent = '';

  try {
    await cuentaAtras(3);
    for (let i = 0; i < cuantas; i++) {
      await disparar();
      if (i < cuantas - 1) await esperar(CONFIG.intervaloMs);
    }
  } catch (error) {
    aviso.textContent = 'No se pudo capturar: ' + error.message;
  } finally {
    capturando = false;
    botonRafaga.disabled = false;
    botonUno.disabled = false;
  }
}

botonRafaga.addEventListener('click', () => secuencia(CONFIG.rafaga));
botonUno.addEventListener('click', () => secuencia(1));

async function arrancar() {
  pintarGuia();
  try {
    const estado = await fetch('/api/estado').then((r) => r.json());
    pintarProgreso(estado.conteo);

    const flujo = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: CONFIG.camaraAnchoIdeal },
        height: { ideal: CONFIG.camaraAltoIdeal },
        facingMode: 'user',
      },
      audio: false,
    });
    video.srcObject = flujo;
    await video.play();

    // La etiqueta del dispositivo solo esta disponible DESPUES de
    // conceder el permiso, y va al manifiesto: un conjunto sin saber
    // con que camara se grabo no se puede comparar con otro.
    dispositivo = flujo.getVideoTracks()[0]?.label ?? '';
  } catch (error) {
    aviso.textContent = 'No se pudo abrir la camara: ' + error.message;
  }
}

arrancar();
</script>
</body>
</html>`;

function leerCuerpo(req, limiteBytes = 24 * 1024 * 1024) {
  return new Promise((resolver, rechazar) => {
    const trozos = [];
    let total = 0;
    req.on('data', (trozo) => {
      total += trozo.length;
      if (total > limiteBytes) {
        rechazar(new Error('cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      trozos.push(trozo);
    });
    req.on('end', () => resolver(Buffer.concat(trozos).toString('utf8')));
    req.on('error', rechazar);
  });
}

const servidor = createServer(async (req, res) => {
  const responder = (codigo, tipo, cuerpo) => {
    res.writeHead(codigo, { 'content-type': tipo });
    res.end(cuerpo);
  };

  try {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      const config = {
        objetivo,
        rafaga,
        intervaloMs: 1400,
        camaraAnchoIdeal: CAMARA_ANCHO_IDEAL,
        camaraAltoIdeal: CAMARA_ALTO_IDEAL,
        terminalAnchoMax: TERMINAL_ANCHO_MAX,
        terminalCalidad: TERMINAL_CALIDAD,
        nativoCalidad: NATIVO_CALIDAD,
      };
      return responder(
        200,
        'text/html; charset=utf-8',
        PAGINA.replace('__CONFIG__', JSON.stringify(config)),
      );
    }

    if (req.method === 'GET' && req.url === '/api/estado') {
      return responder(200, 'application/json', JSON.stringify({ objetivo, conteo }));
    }

    if (req.method === 'POST' && req.url === '/api/disparo') {
      const resultado = guardarDisparo(JSON.parse(await leerCuerpo(req)));
      return responder(200, 'application/json', JSON.stringify(resultado));
    }

    return responder(404, 'text/plain; charset=utf-8', 'No existe');
  } catch (error) {
    return responder(400, 'text/plain; charset=utf-8', error.message);
  }
});

// SOLO 127.0.0.1, y esto no es un detalle: este servidor escribe
// archivos en disco con lo que le llegue por HTTP. Escuchando en todas
// las interfaces, cualquiera en la misma red wifi podria llenar el
// disco del portatil con lo que quisiera.
servidor.listen(puerto, '127.0.0.1', () => {
  const pendientes = Object.entries(conteo)
    .map(([clase, n]) => `${CLASES[clase]}: ${n}/${objetivo}`)
    .join(' · ');

  console.log(
    [
      '',
      '  Captura del conjunto de ataque para la deteccion de vida',
      '  ' + '─'.repeat(56),
      '',
      `  Abre:      http://localhost:${puerto}`,
      `  Guarda en: ${resolve(DIRECTORIO)}`,
      `  Ya habia:  ${pendientes}`,
      '',
      '  Graba las dos clases con la MISMA camara y en la misma sesion:',
      '  la comparacion solo vale si lo unico que cambia es el ataque.',
      '',
      '  Ctrl+C para terminar.',
      '',
    ].join('\n'),
  );
});
