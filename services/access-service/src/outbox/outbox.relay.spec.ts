import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service';
import { OutboxRelay } from './outbox.relay';

Logger.overrideLogger(false);

/**
 * El relay es la pieza que decide si un paso llega o no al cálculo de
 * horas de alguien. Se prueba con dobles en vez de con una base de
 * datos real porque lo que hay que fijar aquí es su comportamiento
 * ante los fallos —qué reintenta, qué no repite, qué no bloquea— y eso
 * es precisamente lo difícil de provocar contra un PostgreSQL vivo.
 */

interface FakeRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  publishedAt: Date | null;
  lastError: string | null;
}

/** Doble de Prisma con solo lo que el relay usa. */
function fakePrisma(rows: FakeRow[]) {
  const tx = {
    $queryRaw: jest.fn(async () =>
      rows
        .filter((row) => row.publishedAt === null && row.attempts < 10)
        .map(({ id, type, payload, attempts }) => ({
          id,
          type,
          payload,
          attempts,
        })),
    ),
    outboxEvent: {
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((candidate) => candidate.id === where.id)!;
        if (data.attempts?.increment) row.attempts += data.attempts.increment;
        if (data.lastError !== undefined) row.lastError = data.lastError;
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const ids = new Set<string>(where.id.in);
        for (const row of rows) {
          if (ids.has(row.id)) row.publishedAt = data.publishedAt;
        }
        return { count: ids.size };
      }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      count: jest.fn(async () => 0),
    },
  };

  return {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    tx,
  } as unknown as PrismaService & { tx: typeof tx };
}

function config(values: Record<string, unknown> = {}) {
  return {
    get: (key: string, fallback: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function row(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    type: 'AccessGranted',
    payload: { eventId: id, type: 'AccessGranted' },
    attempts: 0,
    publishedAt: null,
    lastError: null,
    ...overrides,
  };
}

describe('OutboxRelay', () => {
  it('publica los eventos pendientes y los marca', async () => {
    const rows = [row('a'), row('b')];
    const prisma = fakePrisma(rows);
    const redis = { xadd: jest.fn(async () => '1-0') };

    const relay = new OutboxRelay(prisma, redis as never, config());
    const published = await relay.tick();

    expect(published).toBe(2);
    expect(redis.xadd).toHaveBeenCalledTimes(2);
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
  });

  it('envía el evento completo en un solo campo JSON', async () => {
    const rows = [row('a', { payload: { eventId: 'a', direction: 'IN' } })];
    const prisma = fakePrisma(rows);
    const redis = { xadd: jest.fn(async () => '1-0') };

    await new OutboxRelay(prisma, redis as never, config()).tick();

    expect(redis.xadd).toHaveBeenCalledWith(
      'access.events',
      '*',
      'type',
      'AccessGranted',
      'data',
      JSON.stringify({ eventId: 'a', direction: 'IN' }),
    );
  });

  it('no vuelve a publicar lo ya publicado', async () => {
    const rows = [row('a', { publishedAt: new Date() }), row('b')];
    const prisma = fakePrisma(rows);
    const redis = { xadd: jest.fn(async () => '1-0') };

    const published = await new OutboxRelay(
      prisma,
      redis as never,
      config(),
    ).tick();

    expect(published).toBe(1);
    expect(redis.xadd).toHaveBeenCalledTimes(1);
  });

  it('un evento que falla no bloquea a los que van detrás', async () => {
    // Es la razón de anotar el fallo en la propia fila en vez de
    // abortar el lote: sin esto, un solo evento problemático dejaría
    // la cola entera parada indefinidamente.
    const rows = [row('malo'), row('bueno')];
    const prisma = fakePrisma(rows);
    const redis = {
      xadd: jest.fn(async (_stream: string, _id: string, ..._rest: string[]) => {
        if (redis.xadd.mock.calls.length === 1) throw new Error('sin conexión');
        return '1-0';
      }),
    };

    const published = await new OutboxRelay(
      prisma,
      redis as never,
      config(),
    ).tick();

    expect(published).toBe(1);
    expect(rows[0].publishedAt).toBeNull();
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].lastError).toBe('sin conexión');
    expect(rows[1].publishedAt).not.toBeNull();
  });

  it('deja de reintentar un evento tras agotar los intentos', async () => {
    // Un evento que no consigue salir tras diez intentos es una avería
    // que alguien tiene que mirar, no algo que reintentar para siempre
    // consumiendo la cola en cada vuelta.
    const rows = [row('agotado', { attempts: 10 })];
    const prisma = fakePrisma(rows);
    const redis = { xadd: jest.fn(async () => '1-0') };

    const published = await new OutboxRelay(
      prisma,
      redis as never,
      config(),
    ).tick();

    expect(published).toBe(0);
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('sin Redis no publica nada y no revienta', async () => {
    const prisma = fakePrisma([row('a')]);

    const relay = new OutboxRelay(prisma, null, config());
    relay.onModuleInit();

    await expect(relay.tick()).resolves.toBe(0);
  });

  it('dos vueltas simultáneas no se solapan', async () => {
    // El temporizador dispara cada segundo; si una vuelta tarda más,
    // sin este freno se acumularían vueltas concurrentes publicando el
    // mismo lote.
    const prisma = fakePrisma([row('a')]);
    let release!: () => void;
    const redis = {
      xadd: jest.fn(
        () => new Promise<string>((resolve) => (release = () => resolve('1-0'))),
      ),
    };

    const relay = new OutboxRelay(prisma, redis as never, config());
    const first = relay.tick();
    const second = await relay.tick();

    expect(second).toBe(0);
    release();
    await expect(first).resolves.toBe(1);
  });

  it('un fallo de la transacción no tumba el temporizador', async () => {
    const prisma = {
      $transaction: jest.fn(async () => {
        throw new Error('base de datos caída');
      }),
    } as unknown as PrismaService;
    const redis = { xadd: jest.fn() };

    const relay = new OutboxRelay(prisma, redis as never, config());

    await expect(relay.tick()).resolves.toBe(0);
    // Y la vuelta siguiente vuelve a intentarlo: el freno de solape se
    // libera aunque haya excepción.
    await expect(relay.tick()).resolves.toBe(0);
  });
});
