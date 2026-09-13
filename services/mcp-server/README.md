# Servidor MCP del control de acceso

Expone el dominio como herramientas para que un modelo pueda responder
preguntas sobre el sistema: quién está dentro, qué jornadas hay
abiertas, qué dejó pendiente el turno anterior.

**Solo lectura.** Ninguna herramienta abre una puerta, firma un parte ni
toca una jornada.

---

## Puesta en marcha

```bash
cd services/mcp-server
npm ci
npm run build          # deja dist/main.js, que es lo que se lanza
npm run smoke          # comprueba contra el stack levantado
```

La prueba de humo necesita el stack en marcha (`docker compose up -d`) y
lee las credenciales del `.env` de la raíz si no se las das por entorno.

## Conectarlo a un cliente

Este servidor habla **stdio**: el cliente lo lanza como proceso hijo. No
va en el `docker compose` a propósito —ver el [ADR 0013](../../docs/adr/0013-servidor-mcp.md)—,
así que hay que apuntar al `dist/main.js` construido.

### Claude Code

```bash
claude mcp add detector-acceso \
  --env DETECTOR_ADMIN_EMAIL=tu-cuenta@detector.local \
  --env DETECTOR_ADMIN_PASSWORD=la-contraseña \
  -- node /ruta/absoluta/services/mcp-server/dist/main.js
```

### Claude Desktop

En `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "detector-acceso": {
      "command": "node",
      "args": ["C:\\ruta\\absoluta\\services\\mcp-server\\dist\\index.js"],
      "env": {
        "DETECTOR_ADMIN_EMAIL": "tu-cuenta@detector.local",
        "DETECTOR_ADMIN_PASSWORD": "la-contraseña"
      }
    }
  }
}
```

## Variables

| Variable | Por defecto | Qué es |
|---|---|---|
| `DETECTOR_ADMIN_EMAIL` | — | Cuenta de administración del sistema. **Obligatoria** |
| `DETECTOR_ADMIN_PASSWORD` | — | Su contraseña. **Obligatoria** |
| `DETECTOR_API_URL` | `http://localhost:3000` | Dónde está el API Gateway |
| `DETECTOR_TIMEOUT_MS` | `10000` | Plazo de cada lectura |

Sin las dos primeras el servidor **no arranca**, y lo dice por `stderr`.

## Las tres herramientas

| Herramienta | Qué devuelve |
|---|---|
| `quien_esta_dentro` | Presencia física ahora mismo y aforo por zona |
| `horas_trabajadas` | Jornadas abiertas, su estado y desde cuándo |
| `novedades_de_turno` | Partes de relevo, o solo lo que quedó sin cerrar |

`quien_esta_dentro` avisa en su propia respuesta de que **estar dentro no
es lo mismo que tener la jornada abierta**: quien está `EN_PAUSA` salió
del edificio con la jornada viva y no aparece en la presencia. Es la
distinción que sostiene toda la Fase 2 ([ADR 0007](../../docs/adr/0007-eventos-y-presencia.md)),
y sin decirlo un modelo las mezcla.

---

## Tres cosas que conviene no deshacer

**Es un cliente del Gateway, no de la base de datos.** Pasa por los
mismos guards que el navegador y no tiene ni un privilegio de más. Ir
directo a PostgreSQL sería más rápido y abriría una segunda puerta que
nadie vigila.

**Nada se escribe en `stdout` salvo el protocolo.** El transporte de
stdio usa la salida estándar para los mensajes JSON-RPC: un `console.log`
suelto corrompe la conversación y el cliente se desconecta sin decir por
qué. Por eso existe `aviso()` y escribe en `stderr`.

**Esto enseña datos de terceros a un modelo.** Nombres, horas de entrada
y salida, y lo que alguien declaró en un parte de turno. Las credenciales
que consume son de administración: no lo ejecutes donde no dejarías
abierto el panel de operación.

## Pruebas

```bash
npm test      # 18 casos del formateo, sin red
npm run smoke # 9 comprobaciones contra el stack real
```

Los tests cubren el texto que el modelo acaba leyendo, que es donde vive
casi toda la lógica. **Es la única forma en que este servidor puede hacer
daño:** no puede escribir nada, pero sí contar mal lo que pasó.
