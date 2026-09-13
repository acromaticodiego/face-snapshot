import {
  Camera,
  Check,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { AdminShell } from '@/components/AdminShell';
import { PersonOnboardingDialog } from '@/components/PersonOnboardingDialog';
import { GlassCard, GlowBadge, VaultButton } from '@/components/vault';
import { api, ApiError, type Person } from '@/lib/api';
import { formatDate } from '@/lib/utils';

/** Degradados para el círculo de iniciales, repartidos por nombre. */
const INITIAL_GRADIENTS = [
  'from-vault-purple to-vault-blue',
  'from-vault-orange to-vault-purple',
  'from-vault-green to-vault-blue',
  'from-vault-blue to-vault-purple',
];

function gradientFor(name: string): string {
  // Suma de códigos: la misma persona conserva siempre su color entre
  // recargas, en lugar de cambiar en cada render.
  const seed = [...name].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return INITIAL_GRADIENTS[seed % INITIAL_GRADIENTS.length];
}

/**
 * Qué le falta a una persona para poder pasar por una puerta.
 *
 * `roles === null` NO es «sin rol»: es que no se pudo preguntar al
 * Access Service. Pintarlo igual mandaría al administrador a asignar
 * roles que ya existen.
 */
function pendingStep(person: Person): 'rol' | 'rostro' | null {
  if (person.roles !== null && person.roles.length === 0) return 'rol';
  if (person.enrolledFacesCount === 0) return 'rostro';
  return null;
}

export function AdminFacesPage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /**
   * El alta abierta. `person: null` es un alta nueva desde cero;
   * con persona, es retomar la de alguien a quien le falta un paso.
   */
  const [onboarding, setOnboarding] = useState<{
    person: Person | null;
    step: 'datos' | 'rol' | 'rostro';
  } | null>(null);

  const load = useCallback(async (term?: string) => {
    setLoading(true);
    try {
      const data = await api.listPersons(term);
      setPeople(data.items);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'No se pudo cargar la lista',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Búsqueda con retardo: evita una petición por cada tecla pulsada.
  useEffect(() => {
    const timer = setTimeout(() => void load(search || undefined), 350);
    return () => clearTimeout(timer);
  }, [search, load]);

  const handleDelete = async (person: Person) => {
    const confirmed = window.confirm(
      `¿Eliminar a ${person.fullName}?\n\n` +
        'Se borrarán definitivamente sus datos faciales. Esta acción no se puede deshacer.',
    );
    if (!confirmed) return;

    setDeletingId(person.id);
    try {
      const result = await api.deletePerson(person.id);
      toast.success(
        `${person.fullName} eliminado (${result.deletedEmbeddings} registro(s) facial(es) borrados)`,
      );
      setPeople((prev) => prev.filter((p) => p.id !== person.id));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo eliminar');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <AdminShell
      title="Personas registradas"
      subtitle="Solo se almacena la representación matemática del rostro, nunca la fotografía."
    >
      <>

        {/* ── Alta de persona ──────────────────────────────────── */}
        {/*
          El alta ya no es un formulario suelto, sino un asistente de
          tres pasos: datos, rol y rostro. Un formulario que solo pedía
          el nombre producía personas a las que el sistema reconoce y no
          deja pasar por ninguna puerta, y eran la mitad de las que hay
          registradas.
        */}
        <GlassCard glow="purple" className="mb-6 flex flex-wrap items-center justify-between gap-4 p-6">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <UserPlus className="h-4 w-4 text-vault-blue" />
              Registrar persona
            </h2>
            <p className="mt-1 text-xs text-white/45">
              Datos, rol y captura del rostro. Los tres pasos hacen falta para
              que pueda abrir una puerta.
            </p>
          </div>
          <VaultButton
            onClick={() => setOnboarding({ person: null, step: 'datos' })}
            icon={<UserPlus className="h-4 w-4" />}
          >
            Nueva alta
          </VaultButton>
        </GlassCard>

        {/* ── Buscador ─────────────────────────────────────────── */}
        <GlassCard className="mb-6 flex items-center gap-3 px-4">
          <Search className="h-4 w-4 shrink-0 text-white/35" />
          <input
            name="search"
            placeholder="Buscar por nombre o identificador..."
            className="w-full bg-transparent py-3 text-sm text-white placeholder:text-white/30 focus:outline-none"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </GlassCard>

        {/* ── Listado ──────────────────────────────────────────── */}
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <GlassCard key={i} className="flex items-center gap-4 p-4">
                <div className="h-11 w-11 animate-pulse rounded-full bg-white/10" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-40 animate-pulse rounded bg-white/10" />
                  <div className="h-3 w-24 animate-pulse rounded bg-white/10" />
                </div>
                <div className="h-9 w-24 animate-pulse rounded-xl bg-white/10" />
              </GlassCard>
            ))}
          </div>
        ) : people.length === 0 ? (
          <GlassCard className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="rounded-full border border-white/10 bg-white/5 p-4 text-white/40">
              <Users className="h-7 w-7" />
            </div>
            <h3 className="font-semibold text-white">
              {search ? 'Sin resultados' : 'Todavía no hay nadie'}
            </h3>
            <p className="max-w-sm text-sm text-white/40">
              {search
                ? 'Prueba con otro nombre o identificador.'
                : 'Empieza con «Nueva alta»: datos, rol y rostro.'}
            </p>
          </GlassCard>
        ) : (
          <ul className="space-y-3">
            {people.map((person) => (
              <GlassCard
                key={person.id}
                as="li"
                className="animate-fade-up flex flex-wrap items-center gap-4 p-4"
              >
                <div
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${gradientFor(
                    person.fullName,
                  )} text-sm font-bold text-white shadow-lg`}
                >
                  {person.fullName.slice(0, 1).toUpperCase()}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-white">
                    {person.fullName}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/40">
                    {person.externalId && <span>{person.externalId}</span>}
                    <span>Alta {formatDate(person.createdAt)}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <GlowBadge
                    accent={person.status === 'ACTIVE' ? 'green' : 'orange'}
                  >
                    {person.status === 'ACTIVE' ? 'Activo' : 'Suspendido'}
                  </GlowBadge>

                  {/* El rol vive en otro servicio, así que puede no
                      saberse. «No se sabe» se pinta apagado y sin
                      alarma; «sin rol» sí es un aviso, porque es una
                      persona que no puede pasar por ninguna puerta. */}
                  {person.roles === null ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-0.5 text-xs text-white/35">
                      Rol no disponible
                    </span>
                  ) : person.roles.length === 0 ? (
                    <GlowBadge accent="orange">
                      <ShieldAlert className="h-3 w-3" />
                      Sin rol
                    </GlowBadge>
                  ) : (
                    <GlowBadge accent="green">
                      <ShieldCheck className="h-3 w-3" />
                      {person.roles.map((r) => r.roleName).join(', ')}
                    </GlowBadge>
                  )}

                  <GlowBadge
                    accent={person.enrolledFacesCount > 0 ? 'green' : 'orange'}
                  >
                    {person.enrolledFacesCount > 0 ? (
                      <>
                        <Check className="h-3 w-3" />
                        {person.enrolledFacesCount} rostro
                        {person.enrolledFacesCount > 1 ? 's' : ''}
                      </>
                    ) : (
                      'Sin rostro'
                    )}
                  </GlowBadge>
                </div>

                <div className="flex items-center gap-2">
                  {/* Un solo botón que lleva al paso que le falte a
                      esta persona. Es lo que convierte un alta a medias
                      en algo que se retoma en un clic en lugar de en un
                      registro que nadie vuelve a tocar. */}
                  {pendingStep(person) === 'rol' ? (
                    <VaultButton
                      size="sm"
                      icon={<ShieldAlert className="h-3.5 w-3.5" />}
                      onClick={() => setOnboarding({ person, step: 'rol' })}
                    >
                      Asignar rol
                    </VaultButton>
                  ) : (
                    <VaultButton
                      size="sm"
                      tone={person.enrolledFacesCount > 0 ? 'glass' : 'blue'}
                      icon={<Camera className="h-3.5 w-3.5" />}
                      onClick={() => setOnboarding({ person, step: 'rostro' })}
                    >
                      Capturar
                    </VaultButton>
                  )}
                  <VaultButton
                    size="sm"
                    tone="danger"
                    aria-label={`Eliminar a ${person.fullName}`}
                    loading={deletingId === person.id}
                    onClick={() => void handleDelete(person)}
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                  />
                </div>
              </GlassCard>
            ))}
          </ul>
        )}
      </>

      {onboarding && (
        <PersonOnboardingDialog
          person={onboarding.person}
          initialStep={onboarding.step}
          onClose={() => setOnboarding(null)}
          onFinished={() => {
            setOnboarding(null);
            void load(search || undefined);
          }}
        />
      )}
    </AdminShell>
  );
}
