import { Logger } from '@nestjs/common';

import {
  InMemoryVoteWindowStore,
  normalizeSessionKey,
} from './in-memory-vote-window.store';
import type { VotePolicy } from './vote-window.store';

// El barrendero de ventanas escribe a nivel debug; en la salida del CI
// solo sería ruido entre los resultados de las pruebas.
Logger.overrideLogger(false);

/**
 * La votación multi-frame es la última barrera antes de abrir la
 * puerta y hasta ahora no tenía una sola prueba. Estos casos fijan el
 * comportamiento que el almacén de Redis debe reproducir exactamente:
 * si los dos no votan igual, la infraestructura elegida cambiaría quién
 * entra, y eso convertiría una decisión de despliegue en una decisión
 * de seguridad.
 */

const POLICY: VotePolicy = { required: 3, windowSize: 5, ttlMs: 10_000 };

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

describe('InMemoryVoteWindowStore', () => {
  let store: InMemoryVoteWindowStore;

  beforeEach(() => {
    store = new InMemoryVoteWindowStore(POLICY);
  });

  afterEach(() => {
    store.onModuleDestroy();
  });

  it('no concede el acceso con un solo frame', async () => {
    const result = await store.record(undefined, ALICE, 0.9);

    expect(result.decidedPersonId).toBeNull();
    expect(result.current).toBe(1);
    expect(result.required).toBe(3);
  });

  it('concede el acceso al tercer frame de la misma persona', async () => {
    const key = store.createKey();

    expect((await store.record(key, ALICE, 0.9)).decidedPersonId).toBeNull();
    expect((await store.record(key, ALICE, 0.9)).decidedPersonId).toBeNull();
    expect((await store.record(key, ALICE, 0.9)).decidedPersonId).toBe(ALICE);
  });

  it('consume la ventana al conceder, para que el siguiente vote de cero', async () => {
    const key = store.createKey();
    await store.record(key, ALICE, 0.9);
    await store.record(key, ALICE, 0.9);
    await store.record(key, ALICE, 0.9);

    const after = await store.record(key, ALICE, 0.9);

    expect(after.current).toBe(1);
    expect(after.decidedPersonId).toBeNull();
  });

  it('no acumula votos alternando entre dos personas', async () => {
    const key = store.createKey();

    await store.record(key, ALICE, 0.9);
    await store.record(key, BOB, 0.9);
    await store.record(key, ALICE, 0.9);
    await store.record(key, BOB, 0.9);
    const last = await store.record(key, ALICE, 0.9);

    // Tres frames de Alice, pero la ventana solo guarda los últimos
    // cinco y ninguno de los dos llega a tres... salvo Alice, que sí.
    // Este caso documenta que la ventana deslizante cuenta por persona.
    expect(last.current).toBe(3);
    expect(last.decidedPersonId).toBe(ALICE);
  });

  it('un rostro desconocido intercalado rompe la racha', async () => {
    const key = store.createKey();

    await store.record(key, ALICE, 0.9);
    await store.record(key, null, 0.2);
    await store.record(key, null, 0.2);
    await store.record(key, null, 0.2);
    await store.record(key, null, 0.2);
    const last = await store.record(key, ALICE, 0.9);

    // La ventana de cinco ya expulsó el primer voto de Alice.
    expect(last.current).toBe(1);
    expect(last.decidedPersonId).toBeNull();
  });

  it('un frame sin coincidencia nunca concede acceso', async () => {
    const key = store.createKey();

    await store.record(key, null, 0.2);
    await store.record(key, null, 0.2);
    const last = await store.record(key, null, 0.2);

    expect(last.decidedPersonId).toBeNull();
    expect(last.current).toBe(0);
  });

  it('promedia la similitud de los votos ganadores, no la del último frame', async () => {
    const key = store.createKey();
    await store.record(key, ALICE, 0.6);
    await store.record(key, ALICE, 0.8);
    const result = await store.record(key, ALICE, 1.0);

    expect(result.averageSimilarity).toBeCloseTo(0.8, 5);
  });

  it('empieza de cero cuando la ventana ha caducado', async () => {
    const shortLived = new InMemoryVoteWindowStore({ ...POLICY, ttlMs: 1 });
    const key = shortLived.createKey();

    await shortLived.record(key, ALICE, 0.9);
    await shortLived.record(key, ALICE, 0.9);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterExpiry = await shortLived.record(key, ALICE, 0.9);

    expect(afterExpiry.current).toBe(1);
    expect(afterExpiry.decidedPersonId).toBeNull();
    shortLived.onModuleDestroy();
  });

  it('sesiones distintas no comparten votos', async () => {
    const one = store.createKey();
    const other = store.createKey();

    await store.record(one, ALICE, 0.9);
    await store.record(one, ALICE, 0.9);
    await store.record(other, ALICE, 0.9);
    const last = await store.record(other, ALICE, 0.9);

    expect(last.current).toBe(2);
    expect(last.decidedPersonId).toBeNull();
  });
});

describe('normalizeSessionKey', () => {
  it('conserva un UUID válido enviado por el terminal', () => {
    const key = '33333333-3333-4333-8333-333333333333';
    expect(normalizeSessionKey(key)).toBe(key);
  });

  it('descarta una clave inventada y emite una nueva', () => {
    // Sin este filtro, un cliente podría sembrar el almacén de claves
    // arbitrarias; en Redis eso es espacio de claves gratis para quien
    // quiera ensuciarlo.
    const key = normalizeSessionKey('../../etc/passwd');

    expect(key).not.toBe('../../etc/passwd');
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('emite una clave nueva cuando no llega ninguna', () => {
    expect(normalizeSessionKey(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
