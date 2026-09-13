#!/usr/bin/env node
/**
 * Servidor MCP del control de acceso.
 *
 * Expone el dominio como herramientas para que un modelo pueda
 * responder preguntas sobre el sistema: quién está dentro, cuántas
 * horas lleva alguien, qué dejó pendiente el turno anterior.
 *
 * TRES DECISIONES QUE CONVIENE NO DESHACER
 * ────────────────────────────────────────
 *
 * 1. ES UN CLIENTE DEL GATEWAY, no de la base de datos ni de los
 *    servicios internos. Pasa por los mismos guards que el navegador y
 *    no tiene ni un privilegio de más. Ir directo a PostgreSQL sería
 *    más rápido y abriría una segunda puerta que nadie vigila.
 *
 * 2. SOLO LECTURA. No hay ninguna herramienta que abra una puerta,
 *    firme un parte ni toque una jornada, y no es un olvido: un modelo
 *    de lenguaje conectado a esto puede contar lo que pasó, no hacer
 *    que pase nada. Todas se anuncian con `readOnlyHint`.
 *
 * 3. NADA SE ESCRIBE EN LA SALIDA ESTANDAR salvo el protocolo. El
 *    transporte de stdio usa `stdout` para los mensajes JSON-RPC, así
 *    que un `console.log` suelto corrompe la conversación entera y el
 *    cliente se desconecta sin decir por qué. Los avisos van a
 *    `stderr`, y por eso existe `aviso()` en lugar de usar `console`
 *    directamente.
 *
 * LO QUE SALE POR AQUI SON DATOS DE TERCEROS
 * ──────────────────────────────────────────
 * Nombres, horas de entrada y salida, y lo que alguien declaró en un
 * parte. Conectar esto a un modelo es enseñarle la jornada de personas
 * concretas, así que las credenciales que consume son de
 * administración y el servidor no debería correr donde no correría el
 * panel de operación.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { GatewayClient, GatewayError } from './gateway.js';
import {
  formatHandovers,
  formatPending,
  formatPresence,
  formatShifts,
  type HandoversResponse,
  type PendingResponse,
  type PresenceResponse,
  type ShiftsResponse,
} from './format.js';

/** Único canal de aviso permitido. `stdout` es del protocolo. */
const aviso = (mensaje: string) => process.stderr.write(`[detector-mcp] ${mensaje}\n`);

function leerConfiguracion() {
  const email = process.env.DETECTOR_ADMIN_EMAIL;
  const password = process.env.DETECTOR_ADMIN_PASSWORD;

  if (!email || !password) {
    aviso(
      'Faltan DETECTOR_ADMIN_EMAIL y/o DETECTOR_ADMIN_PASSWORD.\n' +
        'Son las credenciales de una cuenta de administración del sistema.\n' +
        'Ver services/mcp-server/README.md.',
    );
    process.exit(1);
  }

  return {
    baseUrl: process.env.DETECTOR_API_URL ?? 'http://localhost:3000',
    email,
    password,
    timeoutMs: Number(process.env.DETECTOR_TIMEOUT_MS ?? 10_000),
  };
}

/**
 * Envuelve el trabajo de una herramienta.
 *
 * Un fallo se devuelve como CONTENIDO con `isError`, no como una
 * excepción que rompa la conexión: quien pregunta merece leer «el
 * stack no está levantado» en lugar de que la herramienta desaparezca.
 */
async function responder(trabajo: () => Promise<string>) {
  try {
    return { content: [{ type: 'text' as const, text: await trabajo() }] };
  } catch (error) {
    const mensaje =
      error instanceof GatewayError
        ? error.message
        : `Error inesperado: ${(error as Error).message}`;
    aviso(mensaje);
    return {
      content: [{ type: 'text' as const, text: mensaje }],
      isError: true,
    };
  }
}

async function main(): Promise<void> {
  const config = leerConfiguracion();
  const gateway = new GatewayClient(config);

  const server = new McpServer({
    name: 'detector-acceso',
    version: '1.0.0',
  });

  // ── Quién está dentro ────────────────────────────────────────────
  server.registerTool(
    'quien_esta_dentro',
    {
      title: 'Quién está dentro',
      description:
        'Personas que constan físicamente dentro ahora mismo, con el aforo ' +
        'por zona. Es presencia registrada por las puertas, no jornada ' +
        'laboral: alguien con la jornada abierta puede estar fuera del ' +
        'edificio y no aparece aquí.',
      inputSchema: {
        siteId: z.string().uuid().optional().describe('Limitar a una sede'),
        zoneId: z.string().uuid().optional().describe('Limitar a una zona'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ siteId, zoneId }) =>
      responder(async () => {
        const presencia = await gateway.get<PresenceResponse>('/admin/presence', {
          siteId,
          zoneId,
        });

        // Los nombres vienen de las jornadas abiertas: la tabla de
        // presencia guarda identificadores, no nombres. Si esta segunda
        // lectura falla, se enseña la presencia igual y sin nombres,
        // porque el aforo es el dato que se ha pedido.
        const turnos = await gateway
          .get<ShiftsResponse>('/admin/shifts', { siteId })
          .catch(() => null);

        return formatPresence(presencia, turnos);
      }),
  );

  // ── Horas trabajadas ─────────────────────────────────────────────
  server.registerTool(
    'horas_trabajadas',
    {
      title: 'Jornadas y horas',
      description:
        'Jornadas abiertas ahora mismo, con su estado (EN_TURNO, ' +
        'EN_DESCANSO, EN_PAUSA) y desde cuándo. Es una proyección de los ' +
        'eventos de acceso, así que puede ir unos segundos por detrás de ' +
        'lo que registran las puertas.',
      inputSchema: {
        siteId: z.string().uuid().optional().describe('Limitar a una sede'),
        state: z
          .enum(['EN_TURNO', 'EN_DESCANSO', 'EN_PAUSA'])
          .optional()
          .describe('Limitar a un estado de turno'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ siteId, state }) =>
      responder(async () =>
        formatShifts(await gateway.get<ShiftsResponse>('/admin/shifts', { siteId, state })),
      ),
  );

  // ── Novedades de turno ───────────────────────────────────────────
  server.registerTool(
    'novedades_de_turno',
    {
      title: 'Novedades del relevo',
      description:
        'Partes de relevo de turno: lo que declaró quien terminó su ' +
        'jornada, sus incidencias y lo que registraron las puertas en esa ' +
        'franja. Con `solo_pendientes` devuelve únicamente lo que quedó ' +
        'sin cerrar, que es lo que necesita saber quien entra a trabajar.',
      inputSchema: {
        solo_pendientes: z
          .boolean()
          .default(false)
          .describe('Solo las incidencias que siguen abiertas'),
        siteId: z.string().uuid().optional().describe('Limitar a una sede'),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe('Cuántos días atrás mirar (por defecto 7)'),
        take: z.number().int().min(1).max(50).optional().describe('Cuántos partes'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ solo_pendientes, siteId, days, take }) =>
      responder(async () => {
        if (solo_pendientes) {
          return formatPending(
            await gateway.get<PendingResponse>('/admin/logbook/pending', {
              siteId,
              days: days?.toString(),
            }),
          );
        }

        return formatHandovers(
          await gateway.get<HandoversResponse>('/admin/logbook', {
            siteId,
            take: (take ?? 5).toString(),
          }),
        );
      }),
  );

  await server.connect(new StdioServerTransport());
  aviso(`listo · Gateway en ${config.baseUrl}`);
}

main().catch((error: Error) => {
  aviso(`no se pudo arrancar: ${error.message}`);
  process.exit(1);
});
