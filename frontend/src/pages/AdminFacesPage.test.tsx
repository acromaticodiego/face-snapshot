import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Person } from '@/lib/api';

/**
 * El listado de personas.
 *
 * LA DISTINCION QUE ESTE ARCHIVO PROTEGE
 * ──────────────────────────────────────
 * El rol de una persona vive en el Access Service y su identidad en el
 * Face Service. El Gateway los une para esta pantalla, y por eso el
 * campo `roles` tiene TRES estados posibles, no dos:
 *
 *   · una lista con roles  → puede pasar por alguna puerta
 *   · una lista VACIA      → no puede pasar por ninguna. Hay que
 *                            arreglarlo, y la pantalla lo destaca
 *   · `null`               → no se pudo preguntar al Access Service
 *
 * Confundir los dos últimos es el fallo caro: pintar `null` como "sin
 * rol" marcaría a TODA la plantilla en ámbar durante una caída del
 * Access Service, y mandaría a quien administra a asignar roles que ya
 * existen. El error no se notaría nunca, porque la pantalla seguiría
 * pareciendo correcta.
 *
 * Es exactamente el mismo criterio que el backend aplica al listado:
 * `null` es "no se sabe" y `[]` es "no tiene ninguno".
 */

const api = {
  listPersons: vi.fn<() => Promise<{ items: Person[]; total: number }>>(),
  listRoles: vi.fn(async () => ({ items: [] })),
  deletePerson: vi.fn(),
};

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

const { AdminFacesPage } = await import('./AdminFacesPage');

const persona = (overrides: Partial<Person> = {}): Person => ({
  id: 'p-1',
  fullName: 'Diego Ossa',
  externalId: null,
  status: 'ACTIVE',
  enrolledFacesCount: 1,
  roles: [{ roleId: 'r-1', roleName: 'Empleado' }],
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  ...overrides,
});

/**
 * Devuelve la ficha de una persona.
 *
 * Se apoya en que el listado es una lista semántica de verdad, no en la
 * posición ni en una clase de Tailwind: así el test sobrevive a que
 * alguien reordene las fichas o cambie el diseño.
 */
const fichaDe = (nombre: string) => screen.getByText(nombre).closest('li')!;

function montar(personas: Person[]) {
  api.listPersons.mockResolvedValue({ items: personas, total: personas.length });
  return render(
    <MemoryRouter>
      <AdminFacesPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.listRoles.mockResolvedValue({ items: [] });
});

describe('AdminFacesPage · los tres estados del rol', () => {
  it('con rol asignado enseña su nombre', async () => {
    montar([persona()]);

    expect(await screen.findByText('Empleado')).toBeVisible();
    expect(screen.queryByText(/sin rol/i)).not.toBeInTheDocument();
  });

  it('sin rol lo marca como aviso y ofrece asignarlo', async () => {
    montar([persona({ roles: [] })]);

    expect(await screen.findByText(/sin rol/i)).toBeVisible();
    expect(
      screen.getByRole('button', { name: /asignar rol/i }),
    ).toBeVisible();
  });

  it('CUANDO NO SE PUDO PREGUNTAR, no dice "sin rol"', async () => {
    // El test que justifica el archivo. Durante una caída del Access
    // Service toda la plantilla llega con `roles: null`. Si eso se
    // pintara como "sin rol", quien administra saldría a asignar roles
    // que ya existen, y no habría forma de darse cuenta.
    montar([persona({ roles: null })]);

    expect(await screen.findByText(/rol no disponible/i)).toBeVisible();
    expect(screen.queryByText(/^sin rol$/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /asignar rol/i }),
    ).not.toBeInTheDocument();
  });

  it('con los roles desconocidos sigue dejando capturar el rostro', async () => {
    // Los roles son un dato accesorio del listado: que el Access
    // Service no responda no puede bloquear la administración de
    // identidades, que vive en otro servicio y está perfectamente sano.
    montar([persona({ roles: null, enrolledFacesCount: 0 })]);

    expect(
      await screen.findByRole('button', { name: /capturar/i }),
    ).toBeVisible();
  });
});

describe('AdminFacesPage · el botón lleva al paso que falta', () => {
  it('a quien le falta el rol, lo manda a asignarlo aunque ya tenga rostro', async () => {
    // El orden importa: el rol es lo que bloquea el paso por una
    // puerta, así que se resuelve antes que una segunda captura.
    montar([persona({ roles: [], enrolledFacesCount: 3 })]);

    await screen.findByText(/sin rol/i);
    expect(screen.getByRole('button', { name: /asignar rol/i })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /^capturar$/i }),
    ).not.toBeInTheDocument();
  });

  it('a quien ya tiene rol pero no rostro, lo manda a capturar', async () => {
    montar([persona({ enrolledFacesCount: 0 })]);

    await screen.findByText(/sin rostro/i);
    expect(screen.getByRole('button', { name: /capturar/i })).toBeVisible();
  });

  it('a quien lo tiene todo, le sigue permitiendo capturar otro rostro', async () => {
    // Varias capturas por persona mejoran el reconocimiento en
    // condiciones distintas de luz o con gafas.
    montar([persona({ enrolledFacesCount: 2 })]);

    expect(await screen.findByRole('button', { name: /capturar/i })).toBeVisible();
  });
});

describe('AdminFacesPage · el listado', () => {
  it('distingue a cada persona por su estado, no por su posición', async () => {
    // Los nombres son deliberadamente neutros: llamar "Sin Rol" a una
    // persona haría que la búsqueda por texto chocara con la insignia y
    // el test fallaría por su propio enunciado, no por el producto.
    montar([
      persona({ id: 'p-1', fullName: 'Ana Prieto' }),
      persona({ id: 'p-2', fullName: 'Bruno Salas', roles: [] }),
      persona({ id: 'p-3', fullName: 'Carla Vidal', roles: null }),
    ]);

    await screen.findByText('Ana Prieto');

    expect(within(fichaDe('Bruno Salas')).getByText(/sin rol/i)).toBeVisible();
    expect(
      within(fichaDe('Carla Vidal')).getByText(/rol no disponible/i),
    ).toBeVisible();
    expect(within(fichaDe('Ana Prieto')).getByText('Empleado')).toBeVisible();
    // Y que cada aviso esté SOLO donde debe: si el componente pintara
    // `null` como "sin rol", este recuento saltaría.
    expect(screen.getAllByText(/sin rol/i)).toHaveLength(1);
  });

  it('sin nadie registrado invita a empezar por el alta', async () => {
    montar([]);

    expect(await screen.findByText(/todavía no hay nadie/i)).toBeVisible();
    // El botón, no el texto de ayuda que también lo menciona.
    expect(screen.getByRole('button', { name: /nueva alta/i })).toBeVisible();
  });

  it('busca con retardo, no una petición por tecla', async () => {
    // Sin el retardo, escribir "Diego" son cinco peticiones al Gateway
    // que a su vez son cinco al Face Service y cinco al Access Service.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    montar([persona()]);
    await screen.findByText('Diego Ossa');
    api.listPersons.mockClear();

    const buscador = screen.getByPlaceholderText(/buscar/i);
    await userEvent.type(buscador, 'Ossa');
    expect(api.listPersons).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(api.listPersons).toHaveBeenCalledTimes(1));
    vi.useRealTimers();
  });
});
