import {
  ArrowLeft,
  Camera,
  Check,
  IdCard,
  LogOut,
  Search,
  Trash2,
  User,
  UserPlus,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { EnrollDialog } from '@/components/EnrollDialog';
import {
  GlassCard,
  GlassField,
  GlowBadge,
  VaultBackground,
  VaultButton,
  VaultTitle,
} from '@/components/vault';
import { api, ApiError, type Person } from '@/lib/api';
import { adminSession } from '@/lib/auth';
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

export function AdminFacesPage() {
  const navigate = useNavigate();
  const admin = adminSession.getProfile();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [enrolling, setEnrolling] = useState<Person | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newExternalId, setNewExternalId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

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

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);

    if (newName.trim().length < 2) {
      setFormError('El nombre debe tener al menos 2 caracteres');
      return;
    }

    setCreating(true);
    try {
      const person = await api.createPerson({
        fullName: newName.trim(),
        externalId: newExternalId.trim() || undefined,
      });
      setNewName('');
      setNewExternalId('');
      toast.success(`${person.fullName} creado. Ahora captura su rostro.`);
      await load(search || undefined);
      // Encadena directamente con la captura: crear a alguien sin rostro
      // no sirve de nada, así que se guía al operador al paso siguiente.
      setEnrolling(person);
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : 'No se pudo crear la persona',
      );
    } finally {
      setCreating(false);
    }
  };

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
    <div className="relative min-h-dvh bg-vault-bg">
      <VaultBackground />

      <div className="relative z-10 mx-auto max-w-4xl px-4 py-8">
        {/* ── Navegación superior ──────────────────────────────── */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-white/55 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver a la autenticación
          </Link>

          <div className="flex items-center gap-2">
            {admin && (
              <span className="text-sm text-white/55">{admin.displayName}</span>
            )}
            <VaultButton
              size="sm"
              tone="ghost"
              icon={<LogOut className="h-3.5 w-3.5" />}
              onClick={() => {
                adminSession.clear();
                navigate('/admin/login', { replace: true });
              }}
            >
              Salir
            </VaultButton>
          </div>
        </div>

        {/* ── Encabezado ───────────────────────────────────────── */}
        <header className="mb-8">
          <VaultTitle>Personas registradas</VaultTitle>
          <p className="mt-2 text-sm text-white/45">
            Solo se almacena la representación matemática del rostro, nunca la
            fotografía.
          </p>
        </header>

        {/* ── Alta de persona ──────────────────────────────────── */}
        <GlassCard glow="purple" className="mb-6 p-6">
          <h2 className="mb-5 flex items-center gap-2 text-sm font-semibold text-white">
            <UserPlus className="h-4 w-4 text-vault-blue" />
            Registrar persona
          </h2>

          <form
            onSubmit={handleCreate}
            className="flex flex-col gap-4 sm:flex-row sm:items-start"
          >
            <div className="flex-1">
              <GlassField
                accent="purple"
                icon={<User className="h-4 w-4" />}
                label="Nombre completo"
                name="fullName"
                placeholder="Diego Ossa"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                error={formError ?? undefined}
                autoComplete="off"
              />
            </div>
            <div className="flex-1">
              <GlassField
                accent="orange"
                icon={<IdCard className="h-4 w-4" />}
                label="Identificador (opcional)"
                name="externalId"
                placeholder="Cédula o código"
                value={newExternalId}
                onChange={(e) => setNewExternalId(e.target.value)}
                autoComplete="off"
              />
            </div>
            <VaultButton
              type="submit"
              loading={creating}
              className="sm:mt-[1.65rem]"
            >
              Crear
            </VaultButton>
          </form>
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
                : 'Registra la primera persona con el formulario de arriba.'}
            </p>
          </GlassCard>
        ) : (
          <div className="space-y-3">
            {people.map((person) => (
              <GlassCard
                key={person.id}
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

                <div className="flex items-center gap-2">
                  <GlowBadge
                    accent={person.status === 'ACTIVE' ? 'green' : 'orange'}
                  >
                    {person.status === 'ACTIVE' ? 'Activo' : 'Suspendido'}
                  </GlowBadge>
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
                  <VaultButton
                    size="sm"
                    icon={<Camera className="h-3.5 w-3.5" />}
                    onClick={() => setEnrolling(person)}
                  >
                    Capturar
                  </VaultButton>
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
          </div>
        )}
      </div>

      {enrolling && (
        <EnrollDialog
          person={enrolling}
          onClose={() => setEnrolling(null)}
          onEnrolled={() => {
            setEnrolling(null);
            void load(search || undefined);
          }}
        />
      )}
    </div>
  );
}
