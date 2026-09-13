import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  HandoverEntry,
  HandoverPayload,
  LogbookDraft,
  ShiftState,
  ShiftSummary,
} from '@/lib/api';

/**
 * La pantalla de dictar y firmar un parte de relevo.
 *
 * LO QUE ESTE ARCHIVO PROTEGE
 * ───────────────────────────
 * Cuatro reglas que no están escritas en ningún servicio, solo aquí:
 *
 * 1. **Sin jornada abierta no se firma.** Sin ella no hay sede a la que
 *    imputar el parte ni periodo que cubra, y el parte se dicta durante
 *    el turno.
 *
 * 2. **Se llega al final sin micrófono y sin modelo.** Si la
 *    transcripción no está disponible se escribe a mano; si el
 *    estructurador no responde, queda la transcripción y las
 *    incidencias se añaden a mano. Un vigilante que termina su turno no
 *    puede irse sin dejar constancia porque un proveedor esté caído.
 *
 * 3. **Una cita que el modelo no pudo respaldar se ve ANTES de
 *    firmar.** Es lo único que este sistema sabe detectar sobre la
 *    invención de un modelo, y llega hasta aquí desde el Voice Service.
 *
 * 4. **Lo que se firma declara de dónde salió cada incidencia.** Si eso
 *    se envía mal, el dato que debía responder «¿aporta algo el modelo?»
 *    pasa a responder otra cosa.
 *
 * No se comprueba ni una clase de Tailwind, por el mismo motivo que en
 * el resto de la suite: una prueba que se rompe al mover un margen es
 * una que la gente deja de ejecutar.
 */

const api = {
  myShift: vi.fn<() => Promise<ShiftSummary>>(),
  logbookDraft: vi.fn<() => Promise<LogbookDraft>>(),
  signHandover: vi.fn<(p: HandoverPayload) => Promise<HandoverEntry>>(),
  pendingIncidents: vi.fn(),
};

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api,
}));

/** El micrófono no existe en jsdom: se sustituye el hook entero. */
const recorder = {
  status: 'idle' as const,
  error: null as string | null,
  seconds: 0,
  isRecording: false,
  start: vi.fn(async () => true),
  stop: vi.fn(async () => new Blob(['audio'], { type: 'audio/webm' })),
};

vi.mock('@/hooks/useRecorder', () => ({ useRecorder: () => recorder }));

const { HandoverPage } = await import('./HandoverPage');

const SEDE = '11111111-1111-4111-8111-111111111111';

const resumen = (state: ShiftState): ShiftSummary => ({
  state,
  since: '2026-09-13T08:00:00.000Z',
  startedAt: state === 'FUERA' ? null : '2026-09-13T08:00:00.000Z',
  endedAt: null,
  workedSeconds: 24_120,
  breakSeconds: 1_800,
  siteId: state === 'FUERA' ? null : SEDE,
  siteName: 'Sede Principal',
});

const borrador = (
  incidencias: LogbookDraft['estructura'] extends null
    ? never
    : NonNullable<LogbookDraft['estructura']>['incidencias'],
): LogbookDraft => ({
  transcripcion: {
    texto: 'El ascensor del ala norte sigue haciendo ruido.',
    confianza: 0.97,
    duracionSegundos: 12,
    modelo: 'nova-3',
  },
  estructura: { resumen: 'Turno tranquilo.', incidencias },
  estructuraOmitidaPor: null,
  processingTimeMs: 2100,
  transcribeTimeMs: 1400,
  structureTimeMs: 700,
});

const INCIDENCIA = {
  titulo: 'Ruido en el ascensor',
  categoria: 'MANTENIMIENTO' as const,
  gravedad: 'MEDIA' as const,
  horaMencionada: 'las tres y cuarto',
  requiereSeguimiento: true,
  citaLiteral: 'El ascensor del ala norte sigue haciendo ruido',
  citaVerificada: true,
};

function montar(state: ShiftState = 'EN_TURNO') {
  api.myShift.mockResolvedValue(resumen(state));

  return render(
    <MemoryRouter
      initialEntries={[{ pathname: '/relevo', state: { name: 'Diego Ossa' } }]}
    >
      <Routes>
        <Route path="/relevo" element={<HandoverPage />} />
        <Route path="/home" element={<p>pantalla de jornada</p>} />
        <Route path="/" element={<p>pantalla de identificación</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  recorder.isRecording = false;
  recorder.seconds = 0;
  recorder.error = null;
  recorder.stop.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));
});

describe('HandoverPage · sin jornada abierta', () => {
  it('no deja firmar y dice por qué', async () => {
    montar('FUERA');

    expect(
      await screen.findByText(/necesitas una jornada abierta/i),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /dictar el parte/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /firmar/i }),
    ).not.toBeInTheDocument();
  });
});

describe('HandoverPage · se puede llegar al final sin micrófono', () => {
  it('ofrece escribir el parte a mano', async () => {
    montar();
    const usuario = userEvent.setup();

    await usuario.click(
      await screen.findByRole('button', { name: /escribirlo a mano/i }),
    );

    expect(screen.getByLabelText(/resumen del turno/i)).toBeVisible();
    // Sin dictado no hay transcripción que enseñar.
    expect(screen.queryByText(/lo que dijiste/i)).not.toBeInTheDocument();
  });

  it('un parte escrito a mano se firma como ESCRITO y sin modelos', async () => {
    montar();
    const usuario = userEvent.setup();
    api.signHandover.mockResolvedValue({ incidents: [] } as unknown as HandoverEntry);

    await usuario.click(
      await screen.findByRole('button', { name: /escribirlo a mano/i }),
    );
    await usuario.type(
      screen.getByLabelText(/resumen del turno/i),
      'Sin novedades.',
    );
    await usuario.click(screen.getByRole('button', { name: /firmar el parte/i }));

    await waitFor(() => expect(api.signHandover).toHaveBeenCalled());
    const enviado = api.signHandover.mock.calls[0][0];
    expect(enviado.source).toBe('ESCRITO');
    expect(enviado.transcript).toBeUndefined();
    expect(enviado.transcriptionModel).toBeUndefined();
    expect(enviado.siteId).toBe(SEDE);
  });
});

describe('HandoverPage · revisar antes de firmar', () => {
  it('enseña la transcripción y no deja editarla', async () => {
    montar();
    const usuario = userEvent.setup();
    api.logbookDraft.mockResolvedValue(borrador([INCIDENCIA]));

    await usuario.click(
      await screen.findByRole('button', { name: /dictar el parte/i }),
    );
    recorder.isRecording = true;
    await usuario.click(screen.getByRole('button', { name: /dictar el parte/i }));

    expect(await screen.findByText(/lo que dijiste/i)).toBeVisible();
    // La transcripción es lo que zanja las discusiones: se muestra, no
    // se edita. El resumen y las incidencias sí se corrigen.
    const textos = screen.getAllByRole('textbox');
    expect(
      textos.some((t) => (t as HTMLInputElement).value.includes('ala norte')),
    ).toBe(false);
  });

  it('marca una cita que no aparece en lo que se dijo', async () => {
    montar();
    const usuario = userEvent.setup();
    api.logbookDraft.mockResolvedValue(
      borrador([{ ...INCIDENCIA, citaVerificada: false }]),
    );

    await usuario.click(
      await screen.findByRole('button', { name: /dictar el parte/i }),
    );
    recorder.isRecording = true;
    await usuario.click(screen.getByRole('button', { name: /dictar el parte/i }));

    expect(
      await screen.findByText(/no aparece en lo que dijiste/i),
    ).toBeVisible();
  });

  it('una cita respaldada no se marca', async () => {
    montar();
    const usuario = userEvent.setup();
    api.logbookDraft.mockResolvedValue(borrador([INCIDENCIA]));

    await usuario.click(
      await screen.findByRole('button', { name: /dictar el parte/i }),
    );
    recorder.isRecording = true;
    await usuario.click(screen.getByRole('button', { name: /dictar el parte/i }));

    await screen.findByText(/lo que dijiste/i);
    expect(
      screen.queryByText(/no aparece en lo que dijiste/i),
    ).not.toBeInTheDocument();
  });

  it('avisa cuando el estructurador no respondió, y deja firmar igual', async () => {
    montar();
    const usuario = userEvent.setup();
    api.logbookDraft.mockResolvedValue({
      ...borrador([]),
      estructura: null,
      estructuraOmitidaPor: 'El estructurador no respondió',
    });

    await usuario.click(
      await screen.findByRole('button', { name: /dictar el parte/i }),
    );
    recorder.isRecording = true;
    await usuario.click(screen.getByRole('button', { name: /dictar el parte/i }));

    expect(await screen.findByText(/no respondió/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /firmar el parte/i })).toBeEnabled();
  });
});

describe('HandoverPage · lo que se firma', () => {
  async function dictarYRevisar() {
    const usuario = userEvent.setup();
    api.logbookDraft.mockResolvedValue(borrador([INCIDENCIA]));
    api.signHandover.mockResolvedValue({
      incidents: [{}],
    } as unknown as HandoverEntry);

    await usuario.click(
      await screen.findByRole('button', { name: /dictar el parte/i }),
    );
    recorder.isRecording = true;
    await usuario.click(screen.getByRole('button', { name: /dictar el parte/i }));
    await screen.findByText(/lo que dijiste/i);

    return usuario;
  }

  it('una propuesta intacta viaja como aceptada', async () => {
    montar();
    const usuario = await dictarYRevisar();

    await usuario.click(screen.getByRole('button', { name: /firmar el parte/i }));

    await waitFor(() => expect(api.signHandover).toHaveBeenCalled());
    const enviado = api.signHandover.mock.calls[0][0];
    expect(enviado.incidents[0].origin).toBe('PROPUESTA_ACEPTADA');
    expect(enviado.source).toBe('DICTADO');
    expect(enviado.transcriptionModel).toBe('nova-3');
  });

  it('corregir el título la convierte en editada', async () => {
    montar();
    const usuario = await dictarYRevisar();

    const titulo = screen.getByLabelText(/título de la incidencia/i);
    await usuario.clear(titulo);
    await usuario.type(titulo, 'Ascensor averiado');
    await usuario.click(screen.getByRole('button', { name: /firmar el parte/i }));

    await waitFor(() => expect(api.signHandover).toHaveBeenCalled());
    expect(api.signHandover.mock.calls[0][0].incidents[0].origin).toBe(
      'PROPUESTA_EDITADA',
    );
  });

  it('lo que se añade a mano viaja como añadido, y sin respaldo del modelo', async () => {
    montar();
    const usuario = await dictarYRevisar();

    await usuario.click(screen.getByRole('button', { name: /añadir/i }));
    const titulos = screen.getAllByLabelText(/título de la incidencia/i);
    await usuario.type(titulos[1], 'Cámara borrosa en el pasillo dos');
    await usuario.click(screen.getByRole('button', { name: /firmar el parte/i }));

    await waitFor(() => expect(api.signHandover).toHaveBeenCalled());
    const anadida = api.signHandover.mock.calls[0][0].incidents[1];
    expect(anadida.origin).toBe('ANADIDA_POR_PERSONA');
    expect(anadida.quoteVerified).toBe(false);
  });

  it('no deja firmar con una incidencia sin título', async () => {
    montar();
    const usuario = await dictarYRevisar();

    await usuario.click(screen.getByRole('button', { name: /añadir/i }));

    expect(screen.getByRole('button', { name: /firmar el parte/i })).toBeDisabled();
    expect(screen.getByText(/incidencia sin título/i)).toBeVisible();
  });

  it('un parte sin incidencias se puede firmar', async () => {
    // La mayoría de los turnos no tienen ninguna. Exigir al menos una
    // empujaría a inventarse algo.
    montar();
    const usuario = userEvent.setup();
    api.logbookDraft.mockResolvedValue(borrador([]));
    api.signHandover.mockResolvedValue({ incidents: [] } as unknown as HandoverEntry);

    await usuario.click(
      await screen.findByRole('button', { name: /dictar el parte/i }),
    );
    recorder.isRecording = true;
    await usuario.click(screen.getByRole('button', { name: /dictar el parte/i }));
    await screen.findByText(/lo que dijiste/i);

    await usuario.click(screen.getByRole('button', { name: /firmar el parte/i }));
    await waitFor(() => expect(api.signHandover).toHaveBeenCalled());
    expect(api.signHandover.mock.calls[0][0].incidents).toHaveLength(0);
  });
});
