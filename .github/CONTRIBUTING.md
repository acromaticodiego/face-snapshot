# Cómo pasar la integración continua

Todo lo que el CI comprueba se puede ejecutar en local **antes** de
subir nada. Esta página dice cómo, y qué suele fallar.

El flujo de trabajo del proyecto es: rama de feature con nombre en
inglés → commits → push → pull request. Nunca commits directos a `main`.

---

## Comprobarlo todo antes de subir

```bash
# Desde la raíz del proyecto
node scripts/ci-local.mjs
```

Ese script ejecuta exactamente los mismos pasos que GitHub Actions. Si
pasa en local, pasa en el CI.

---

## Qué comprueba el CI, trabajo por trabajo

### 1. Servicios NestJS

Se ejecuta por separado para `api-gateway`, `services/auth-service`,
`services/face-service` y `services/access-service`.

| Paso | Comando | Qué valida |
|---|---|---|
| Dependencias | `npm ci` | Que `package-lock.json` esté sincronizado con `package.json` |
| Cliente Prisma | `npx prisma generate` | Solo en servicios con `prisma/schema.prisma` |
| Tipos | `npx tsc --noEmit -p tsconfig.json` | Que no haya errores de TypeScript |
| Compilación | `npm run build` | Que genere `dist/main.js` |
| Tests | `npm test` | Si el servicio tiene tests definidos |

En local, dentro de la carpeta del servicio:

```bash
npm ci
npx prisma generate      # si tiene schema
npx tsc --noEmit -p tsconfig.json
npm run build
npm test
```

### 2. Frontend

```bash
cd frontend
npm ci
npx tsc --noEmit
npm run build
```

### 3. Vision Service

Solo comprueba sintaxis. **No instala PyTorch ni descarga los modelos**:
son cientos de megabytes y tardarían más que todo lo demás junto.

```bash
cd services/vision-service
python -m compileall -q app scripts
```

La verificación real del pipeline de reconocimiento se hace en local,
donde sí están el modelo y las dependencias:

```bash
python scripts/inspect_model.py
PYTHONPATH=. python tests/test_recognition_quality.py
```

### 4. Sin secretos en el repositorio

Falla si encuentra:

- Un fichero `.env` versionado.
- Un valor real en `.env.example` para cualquier variable que sea
  contraseña, secreto o clave de API.

En `.env.example` esos valores van **vacíos** a propósito. Un marcador
copiable como `PASSWORD=cambiar_esta_password` acaba llegando a
producción sin cambiar.

```bash
git ls-files | grep -E '(^|/)\.env$'                       # debe estar vacío
grep -E '^(JWT_SECRET|.*PASSWORD|.*API_KEY)=.+' .env.example  # debe estar vacío
```

---

## Fallos habituales

### `Cannot find module './algo'` — pero en local compila

**Casi siempre es un archivo que existe en tu disco pero no está en el
repositorio.** El CI parte de un clon limpio; tú no.

Ocurrió de verdad en este proyecto: la regla `logs/` del `.gitignore`
no estaba anclada a la raíz, así que coincidía con *cualquier*
directorio llamado `logs`, incluido el código fuente de
`services/access-service/src/logs/`. Todo compilaba en local y el CI
fallaba con `Cannot find module './logs/access-logs.service'`.

Cómo detectarlo:

```bash
# ¿Hay código fuente ignorado por error?
git status --ignored --short | grep '^!!' \
  | grep -vE 'node_modules|\.venv|dist/|__pycache__|\.env|coverage'

# ¿Por qué se ignora este archivo concreto?
git check-ignore -v ruta/al/archivo.ts
```

Al añadir una regla al `.gitignore`, **ancla los nombres genéricos a la
raíz con `/`**: `logs/` ignora código fuente; `/logs/` no.

### `npm ci` falla con `EUSAGE` o desincronización

`npm ci` exige que el `package-lock.json` corresponda exactamente al
`package.json`. Si añadiste una dependencia editando el `package.json` a
mano, regenera el lock:

```bash
npm install --package-lock-only
```

Y **commitea el lock**.

### El servicio compila pero no arranca: falta `dist/main.js`

`tsconfig.json` de los servicios con Prisma excluye `prisma.config.ts` y
`prisma/`. Sin esa exclusión, TypeScript sube el `rootDir` al directorio
del proyecto y emite `dist/src/main.js` en lugar de `dist/main.js`, que
es lo que arranca el contenedor.

Si tocas el `tsconfig.json`, comprueba:

```bash
npm run build && ls dist/main.js
```

### Los tests pasan en local y fallan en el CI

Suele ser dependencia del entorno. En este proyecto el motor de
autorización trabaja con zonas horarias, así que los tests fijan
instantes explícitos en UTC y la zona de la sede; **nunca usan la hora
del sistema**. Si escribes un test que dependa de `new Date()` sin
fijarlo, fallará según la hora a la que se ejecute.

### `type "X" already exists` al aplicar migraciones

Quedó estado parcial de una migración anterior fallida. En desarrollo:

```bash
docker compose down -v      # borra el volumen: se pierden los datos
docker compose up postgres -d
cd services/<servicio> && npx prisma migrate deploy
```

---

## Antes de abrir el pull request

- [ ] La rama se llama `feature/<algo-en-ingles>`
- [ ] `node scripts/ci-local.mjs` pasa
- [ ] No hay ficheros nuevos ignorados por error
- [ ] Los `package-lock.json` modificados están commiteados
- [ ] Si tocaste un schema de Prisma, hay migración y está aplicada
- [ ] Ningún `.env` en el commit

---

## Sobre las migraciones de Prisma

En este proyecto **se escriben a mano**. No es pereza: las migraciones
no crean el schema ni las extensiones de PostgreSQL, porque eso lo hace
`infrastructure/postgres/init/01-init.sql` como superusuario y un rol de
aplicación no debe poder crear schemas.

Esa decisión —correcta para producción— impide que Prisma reproduzca las
migraciones en su base de datos "sombra", que es como genera los diffs
automáticamente. El precio es escribirlas a mano; la contrapartida es
que ningún servicio tiene privilegios de más.

Al añadir una migración:

1. Crea `prisma/migrations/<timestamp>_<nombre>/migration.sql`.
2. Escribe el SQL con `IF NOT EXISTS` donde tenga sentido.
3. Aplícala con `npx prisma migrate deploy`.
4. Comprueba el resultado contra la base de datos.
