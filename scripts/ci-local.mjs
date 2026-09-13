#!/usr/bin/env node
/**
 * Ejecuta en local las mismas comprobaciones que GitHub Actions.
 *
 *   node scripts/ci-local.mjs              todo
 *   node scripts/ci-local.mjs --rapido     salta `npm ci` (usa node_modules existentes)
 *
 * DIFERENCIA IMPORTANTE CON EL CI
 * -------------------------------
 * El CI parte de un clon limpio; aquí se trabaja sobre tu copia de
 * trabajo. Por eso la primera comprobación es la que más veces salva:
 * detectar código fuente que existe en tu disco pero NO está en el
 * repositorio. Ese fallo es invisible en local y rompe el CI siempre.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const fast = process.argv.includes('--rapido');

const NODE_SERVICES = [
  'api-gateway',
  'services/auth-service',
  'services/face-service',
  'services/access-service',
  'services/shift-service',
  'services/logbook-service',
  'services/mcp-server',
];

let failures = 0;

const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg, detail = '') => {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  if (detail) console.log(`\x1b[90m${detail.trimEnd()}\x1b[0m`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function run(command, cwd) {
  try {
    const output = execSync(command, {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
    });
    return { ok: true, output };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

function step(label, command, cwd) {
  const result = run(command, cwd);
  if (result.ok) ok(label);
  else bad(label, result.output.split('\n').slice(0, 12).join('\n'));
  return result.ok;
}

// ── 1. Código fuente que falta en el repositorio ──────────────────
section('1. Integridad del repositorio');

const ignored = run(
  'git status --ignored --short',
  process.cwd(),
).output
  .split('\n')
  .filter((line) => line.startsWith('!!'))
  .map((line) => line.slice(3).trim())
  .filter(
    (path) =>
      !/node_modules|\.venv|dist\/|__pycache__|\.env|coverage|tsbuildinfo|\.git\//.test(
        path,
      ),
  );

if (ignored.length === 0) {
  ok('Ningún código fuente ignorado por error');
} else {
  bad('Hay rutas ignoradas que podrían ser código fuente:');
  for (const path of ignored) {
    const why = run(`git check-ignore -v "${path}"`, process.cwd()).output.trim();
    console.log(`      ${path}`);
    console.log(`\x1b[90m        ${why}\x1b[0m`);
  }
  console.log(
    '\x1b[90m      Si es código, ancla la regla del .gitignore con "/" al inicio.\x1b[0m',
  );
}

// ── 2. Secretos ───────────────────────────────────────────────────
section('2. Sin secretos en el repositorio');

const envFiles = run('git ls-files', process.cwd())
  .output.split('\n')
  .filter((path) => /(^|\/)\.env$/.test(path));

if (envFiles.length === 0) ok('Ningún .env versionado');
else bad('Hay ficheros .env versionados', envFiles.join('\n'));

const exampleLeaks = run(
  'grep -nE "^(JWT_SECRET|.*PASSWORD|.*API_KEY)=.+" .env.example || true',
  process.cwd(),
).output.trim();

if (!exampleLeaks) ok('.env.example solo tiene marcadores vacíos');
else bad('.env.example contiene valores', exampleLeaks);

// ── 3. Servicios NestJS ───────────────────────────────────────────
for (const service of NODE_SERVICES) {
  section(`3. ${service}`);
  const cwd = join(process.cwd(), service);

  if (!fast) {
    if (!step('npm ci', 'npm ci --no-audit --no-fund', cwd)) continue;
  }

  if (existsSync(join(cwd, 'prisma', 'schema.prisma'))) {
    if (!step('prisma generate', 'npx prisma generate', cwd)) continue;
  }

  step('Tipos', 'npx tsc --noEmit -p tsconfig.json', cwd);
  const built = step('Compilación', 'npm run build', cwd);

  // El contenedor arranca `node dist/main`: si no está ahí, el
  // servicio compila pero no levanta.
  if (built && !existsSync(join(cwd, 'dist', 'main.js'))) {
    bad('Falta dist/main.js (¿rootDir mal configurado?)');
  }

  const pkg = JSON.parse(
    run('node -p "JSON.stringify(require(\'./package.json\'))"', cwd).output ||
      '{}',
  );
  if (pkg.scripts?.test) step('Tests', 'npm test', cwd);
}

// ── 4. Frontend ───────────────────────────────────────────────────
section('4. frontend');
{
  const cwd = join(process.cwd(), 'frontend');
  if (fast || step('npm ci', 'npm ci --no-audit --no-fund', cwd)) {
    step('Tipos', 'npx tsc --noEmit', cwd);
    step('Compilación', 'npm run build', cwd);
    step('Tests', 'npm test', cwd);
  }
}

// ── 5. Vision Service ─────────────────────────────────────────────
section('5. services/vision-service');
step(
  'Sintaxis de Python',
  'python -m compileall -q app scripts',
  join(process.cwd(), 'services', 'vision-service'),
);

// ── 6. Voice Service ──────────────────────────────────────────────
//
// Aqui SI se ejecutan las pruebas, a diferencia del Vision Service.
// La razon es que se pueden: `app/services/citas.py` no depende de
// nada fuera de la biblioteca estandar, asi que corren sin instalar
// fastapi, ni httpx, ni pytest. Comprueban la unica garantia de este
// servicio que no depende de un tercero: que una incidencia cuya cita
// no esta en la transcripcion queda MARCADA.
section('6. services/voice-service');
{
  const cwd = join(process.cwd(), 'services', 'voice-service');
  step('Sintaxis de Python', 'python -m compileall -q app tests', cwd);

  // Los tests de `citas.py` no dependen de nada fuera de la biblioteca
  // estándar y corren siempre. Los del reintento SI necesitan httpx,
  // porque el módulo que prueban lo importa para distinguir los
  // errores de transporte por su tipo.
  //
  // Cuando falta, se ejecutan los que se pueda y se DICE cuáles no,
  // en lugar de callarlo o de dar por bueno un "sin tests". En el CI
  // de GitHub sí se instala, así que allí corren todos.
  const conHttpx = run('python -c "import httpx"', cwd).ok;

  step(
    conHttpx ? 'Tests' : 'Tests (solo los que no necesitan httpx)',
    conHttpx
      ? 'python -m unittest discover -s tests -q'
      : 'python -m unittest discover -s tests -q -p "test_citas*.py"',
    cwd,
  );

  if (!conHttpx) {
    console.log(
      '[90m      httpx no está instalado: los tests del reintento se ' +
        'ejecutan en el CI y en el contenedor.[0m',
    );
  }
}

// ── Resumen ───────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
if (failures === 0) {
  console.log('  \x1b[32mTodo en verde. El CI debería pasar.\x1b[0m');
} else {
  console.log(`  \x1b[31m${failures} comprobación(es) fallida(s).\x1b[0m`);
}
console.log('─'.repeat(52));

process.exit(failures > 0 ? 1 : 0);
