import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShiftState, ShiftSummary, TimelineEntry, WorkDay } from '@/lib/api';

/**
 * La pantalla que ve una persona tras identificarse.
 *
 * LO QUE ESTE ARCHIVO PROTEGE, Y NO ES EL DISEÑO
 * ─────────────────────────────────────────────
 * Aquí vive una regla del dominio que no está escrita en ningún
 * servicio, solo en este JSX: **qué puede y qué no puede hacer un
 * botón.**
 *
 * Declarar un descanso, sí: ir al baño o bajar a por un café no cruzan
 * ningún lector, y sin poder declararlos la jornada contaría como
 * trabajado todo el rato que se pase dentro del edificio.
 *
 * Fichar la entrada o la salida, JAMAS. Eso lo decide el Access Service
 * con una cara delante de una cámara, y un botón que abriera jornada
 * convertiría el control de acceso en un adorno.
 *
 * Y el caso que más fácil se rompe: quien está `EN_PAUSA` está FUERA
 * del edificio. No puede declarar nada, porque su vuelta la registra la
 * puerta. Un botón de "volver al trabajo" ahí sería fichar sin estar.
 *
 * No se comprueba ni una clase de Tailwind: los estilos cambian cada
 * vez que alguien ajusta el diseño, y una suite que se rompe al mover
 * un margen es una suite que la gente deja de ejecutar.
 */

const api = {
  myShift: vi.fn<() => Promise<ShiftSummary>>(),
  myTimeline: vi.fn<() => Promise<{ items: WorkDay[] }>>(),
  startBreak: vi.fn<() => Promise<ShiftSummary>>(),
  endBreak: vi.fn<() => Promise<ShiftSummary>>(),
};

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api,
}));

const { HomePage } = await import('./HomePage');

const resumen = (state: ShiftState): ShiftSummary => ({
  state,
  since: '2026-09-13T08:00:00.000Z',
  startedAt: state === 'FUERA' ? null : '2026-09-13T08:00:00.000Z',
  endedAt: null,
  workedSeconds: 24_120,
  breakSeconds: 1_800,
  siteName: 'Sede Principal',
});

/** Monta la pantalla como si se llegara tras un acceso concedido. */
function montar(state: ShiftState, jornada: WorkDay | null = null) {
  api.myShift.mockResolvedValue(resumen(state));
  api.myTimeline.mockResolvedValue({ items: jornada ? [jornada] : [] });

  return render(
    <MemoryRouter
      initialEntries={[
        { pathname: '/home', state: { name: 'Diego Ossa', passage: 'IN' } },
      ]}
    >
      <Routes>
        <Route path="/home" element={<HomePage />} />
        <Route path="/" element={<p>pantalla de identificación</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.startBreak.mockResolvedValue(resumen('EN_DESCANSO'));
  api.endBreak.mockResolvedValue(resumen('EN_TURNO'));
});

describe('HomePage · lo que un botón puede hacer', () => {
  it('EN_TURNO ofrece declarar un descanso', async () => {
    montar('EN_TURNO');

    expect(await screen.findByRole('button', { name: /descanso/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /almuerzo/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /baño/i })).toBeVisible();
  });

  it('EN_TURNO no ofrece NINGUNA forma de fichar', async () => {
    // El fichaje es del Access Service, con una cara delante de una
    // cámara. Si algún día aparece aquí un botón de entrada o salida,
    // este test tiene que gritar.
    montar('EN_TURNO');
    await screen.findByRole('button', { name: /descanso/i });

    const botones = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(botones.join(' | ')).not.toMatch(/fichar|entrada|salida|abrir/i);
  });

  it('EN_DESCANSO ofrece volver al trabajo y ya no ofrece más descansos', async () => {
    montar('EN_DESCANSO');

    expect(
      await screen.findByRole('button', { name: /volver al trabajo/i }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /almuerzo/i }),
    ).not.toBeInTheDocument();
  });

  it('EN_PAUSA no ofrece NINGUN control: la persona está fuera del edificio', async () => {
    // El caso que justifica el archivo. `EN_PAUSA` significa que salió
    // de la sede; su vuelta la registra la puerta, no un botón.
    montar('EN_PAUSA');

    expect(await screen.findByText(/fuera de la sede/i)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /volver al trabajo/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /almuerzo|descanso|baño/i }),
    ).not.toBeInTheDocument();
  });

  it('FUERA no ofrece declarar nada', async () => {
    // Sin jornada abierta no hay nada que pausar. Reabrirla exige
    // volver a pasar por la cámara.
    montar('FUERA');

    await screen.findByText(/jornada cerrada/i);
    expect(
      screen.queryByRole('button', { name: /almuerzo|volver al trabajo/i }),
    ).not.toBeInTheDocument();
  });

  it('al declarar un descanso lo manda con su motivo y recarga la jornada', async () => {
    montar('EN_TURNO');
    const boton = await screen.findByRole('button', { name: /almuerzo/i });

    await userEvent.click(boton);

    await waitFor(() => expect(api.startBreak).toHaveBeenCalledWith('ALMUERZO'));
    // Se recarga la línea de tiempo: el estado lo devuelve la respuesta,
    // pero la entrada nueva del día no, y verla aparecer es lo que
    // confirma que quedó registrada.
    expect(api.myTimeline).toHaveBeenCalledTimes(2);
  });
});

describe('HomePage · lo que enseña', () => {
  it('saluda por el nombre de pila', async () => {
    montar('EN_TURNO');

    expect(await screen.findByText('Diego')).toBeVisible();
  });

  it('no deja entrar por URL sin haberse identificado', async () => {
    // Es comodidad de navegación, no seguridad —los datos los protege
    // el token—, pero sin esto la pantalla se monta sin nombre y falla
    // al partirlo.
    api.myShift.mockResolvedValue(resumen('EN_TURNO'));
    api.myTimeline.mockResolvedValue({ items: [] });

    render(
      <MemoryRouter initialEntries={['/home']}>
        <Routes>
          <Route path="/home" element={<HomePage />} />
          <Route path="/" element={<p>pantalla de identificación</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('pantalla de identificación')).toBeVisible();
  });

  it('un fallo consultando la jornada no borra la confirmación de identidad', async () => {
    // Quien está delante acaba de ser reconocido: que el servicio de
    // turnos falle no puede hacer que la pantalla deje de decírselo.
    api.myShift.mockRejectedValue(new Error('shift-service caído'));
    api.myTimeline.mockRejectedValue(new Error('shift-service caído'));

    render(
      <MemoryRouter
        initialEntries={[
          { pathname: '/home', state: { name: 'Diego Ossa', passage: 'IN' } },
        ]}
      >
        <Routes>
          <Route path="/home" element={<HomePage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Diego')).toBeVisible();
  });

  it('al fichar la salida cambia el saludo por una despedida', async () => {
    api.myShift.mockResolvedValue(resumen('FUERA'));
    api.myTimeline.mockResolvedValue({ items: [] });

    render(
      <MemoryRouter
        initialEntries={[
          { pathname: '/home', state: { name: 'Diego Ossa', passage: 'OUT' } },
        ]}
      >
        <Routes>
          <Route path="/home" element={<HomePage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/hasta luego/i)).toBeVisible();
  });
});

/**
 * La línea de tiempo del día.
 *
 * El texto de cada paso se construye a partir de la TRANSICION y no de
 * la zona, para que se lea como algo que ocurrió —"Vuelta al trabajo"—
 * y no como un volcado de la base de datos —"OUT · Cafetería"—.
 *
 * La función que lo decide es una cadena de `if` donde el ORDEN manda:
 * el motivo declarado gana al estado de destino, y el estado de destino
 * gana al de origen. Reordenar esas ramas no rompe nada visible, solo
 * hace que la historia del día se cuente mal, y nadie compara su línea
 * de tiempo con la base de datos.
 */

const paso = (overrides: Partial<TimelineEntry> = {}): TimelineEntry => ({
  at: '2026-09-13T08:00:00.000Z',
  fromState: 'FUERA',
  toState: 'EN_TURNO',
  direction: 'IN',
  zoneName: 'Oficinas',
  // Deliberadamente sin la palabra "Entrada": el nombre del punto de
  // acceso se pinta junto a la etiqueta del paso, y llamarlo "Entrada
  // Principal" haria que la busqueda de la etiqueta "Entrada" encontrara
  // las dos cosas. El test fallaria por su propio enunciado.
  accessPointName: 'Puerta Norte',
  origin: 'ACCESS',
  note: null,
  ...overrides,
});

const jornadaCon = (entries: TimelineEntry[]): WorkDay => ({
  id: 'wd-1',
  businessDate: '2026-09-13',
  state: 'EN_TURNO',
  startedAt: '2026-09-13T08:00:00.000Z',
  endedAt: null,
  closedBy: null,
  workedSeconds: 24_120,
  breakSeconds: 1_800,
  siteName: 'Sede Principal',
  entries,
});

describe('HomePage · la línea de tiempo', () => {
  it('nombra cada transición por lo que ocurrió', async () => {
    montar(
      'EN_TURNO',
      jornadaCon([
        paso(),
        paso({ fromState: 'EN_TURNO', toState: 'EN_PAUSA', direction: 'OUT' }),
        paso({ fromState: 'EN_PAUSA', toState: 'EN_TURNO', direction: 'IN' }),
        paso({ fromState: 'EN_TURNO', toState: 'FUERA', direction: 'OUT' }),
      ]),
    );

    expect(await screen.findByText(/entrada/i)).toBeVisible();
    expect(screen.getByText(/salida temporal/i)).toBeVisible();
    expect(screen.getByText(/vuelta al trabajo/i)).toBeVisible();
    expect(screen.getByText(/fin de jornada/i)).toBeVisible();
  });

  it('el motivo declarado gana al estado de destino', async () => {
    // Si el orden de las ramas se invirtiera, un almuerzo se
    // etiquetaría genéricamente como "Descanso" y se perdería el
    // detalle que la persona se molestó en declarar.
    montar(
      'EN_DESCANSO',
      jornadaCon([
        paso({
          fromState: 'EN_TURNO',
          toState: 'EN_DESCANSO',
          origin: 'MANUAL',
          note: 'ALMUERZO',
          direction: null,
        }),
      ]),
    );

    expect(await screen.findByText(/almuerzo/i)).toBeVisible();
  });

  it('distingue quién provocó cada paso', async () => {
    // Importa para entender la propia jornada: no es lo mismo haber
    // declarado un descanso que haber cruzado una puerta, ni que el
    // sistema haya cerrado la jornada por ti pasado el tiempo.
    montar(
      'EN_TURNO',
      jornadaCon([
        paso({ origin: 'ACCESS', accessPointName: 'Puerta Norte' }),
        paso({
          fromState: 'EN_TURNO',
          toState: 'EN_DESCANSO',
          origin: 'MANUAL',
          note: 'BANO',
          direction: null,
        }),
        paso({ fromState: 'EN_TURNO', toState: 'FUERA', origin: 'SYSTEM' }),
      ]),
    );

    expect(await screen.findByText('Puerta Norte')).toBeVisible();
    expect(screen.getByText(/declarado por ti/i)).toBeVisible();
    expect(screen.getByText(/cerrado autom/i)).toBeVisible();
  });

  it('sin entradas no pinta una línea de tiempo vacía', async () => {
    montar('EN_TURNO', null);

    await screen.findByText('Diego');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
