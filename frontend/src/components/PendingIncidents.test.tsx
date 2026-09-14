import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, type PendingIncident } from '@/lib/api';

import { PendingIncidents } from './PendingIncidents';

/**
 * Cerrar lo que dejó pendiente el turno anterior.
 *
 * LA REGLA QUE ESTO PROTEGE
 * ─────────────────────────
 * **La incidencia se quita de la lista cuando el servidor confirma, no
 * antes.** Quitarla de forma optimista es lo cómodo y lo que se suele
 * hacer, y aquí sería un error: si la petición falla, desaparece de la
 * pantalla algo que SIGUE pendiente, y lo que se pierde es exactamente
 * lo que esta tarjeta existe para no perder. Quien entra al turno se
 * va a casa creyendo que el ascensor está arreglado.
 *
 * El otro caso es el de dos personas cerrando a la vez: el servidor
 * responde `alreadyResolved` en vez de un error, y aquí tiene que
 * tratarse igual que un cierre propio, porque el resultado que importa
 * —ya no está pendiente— es el mismo.
 */

const INCIDENCIA: PendingIncident = {
  id: 'inc-1',
  title: 'Mantenimiento de ascensor pendiente',
  category: 'MANTENIMIENTO',
  severity: 'MEDIA',
  mentionedTime: null,
  quote: null,
  quoteVerified: true,
  entry: {
    id: 'e-1',
    personName: 'diego ossa',
    siteName: 'Sede Principal',
    businessDate: '2026-09-13',
    coversTo: '2026-09-13T22:00:00.000Z',
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'pendingIncidents').mockResolvedValue({
    items: [INCIDENCIA],
    total: 1,
    sinceDays: 7,
  });
});

describe('PendingIncidents', () => {
  it('enseña lo que quedó pendiente y quién lo dejó', async () => {
    render(<PendingIncidents />);
    expect(await screen.findByText(INCIDENCIA.title)).toBeInTheDocument();
    expect(screen.getByText(/lo dejó diego ossa/)).toBeInTheDocument();
  });

  it('al cerrarla desaparece de la lista', async () => {
    const resolver = vi
      .spyOn(api, 'resolveIncident')
      .mockResolvedValue({ alreadyResolved: false });

    render(<PendingIncidents />);
    await userEvent.click(await screen.findByRole('button'));

    expect(resolver).toHaveBeenCalledWith('inc-1');
    await waitFor(() =>
      expect(screen.queryByText(INCIDENCIA.title)).not.toBeInTheDocument(),
    );
  });

  it('SI FALLA EL CIERRE, LA INCIDENCIA SE QUEDA', async () => {
    // El caso que justifica no quitarla de forma optimista. Si
    // desapareciera igualmente, alguien se iría a casa creyendo que el
    // ascensor está arreglado.
    vi.spyOn(api, 'resolveIncident').mockRejectedValue(new Error('sin red'));

    render(<PendingIncidents />);
    await userEvent.click(await screen.findByRole('button'));

    expect(await screen.findByText(/No se pudo cerrar/)).toBeInTheDocument();
    expect(screen.getByText(INCIDENCIA.title)).toBeInTheDocument();
  });

  it('que otro la hubiera cerrado ya NO es un fallo', async () => {
    // Dos personas entrando al turno a la vez. El resultado que importa
    // es el mismo: ya no está pendiente.
    vi.spyOn(api, 'resolveIncident').mockResolvedValue({
      alreadyResolved: true,
    });

    render(<PendingIncidents />);
    await userEvent.click(await screen.findByRole('button'));

    await waitFor(() =>
      expect(screen.queryByText(INCIDENCIA.title)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/No se pudo cerrar/)).not.toBeInTheDocument();
  });

  it('sin nada pendiente no ocupa sitio', async () => {
    vi.spyOn(api, 'pendingIncidents').mockResolvedValue({
      items: [],
      total: 0,
      sinceDays: 7,
    });

    const { container } = render(<PendingIncidents />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
