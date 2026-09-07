import {
  ArrowLeft,
  Camera,
  Check,
  LogOut,
  Search,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
} from '@/components/ui';
import { EnrollDialog } from '@/components/EnrollDialog';
import { api, ApiError, type Person } from '@/lib/api';
import { adminSession } from '@/lib/auth';
import { formatDate } from '@/lib/utils';

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
      toast.error(
        err instanceof ApiError ? err.message : 'No se pudo eliminar',
      );
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="min-h-dvh bg-surface-100 dark:bg-surface-950">
      <div className="mx-auto max-w-4xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-surface-600 transition-colors hover:text-brand-600"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver a la autenticación
          </Link>

          <div className="flex items-center gap-3">
            {admin && (
              <span className="text-xs text-surface-600">
                {admin.displayName}
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<LogOut className="h-3.5 w-3.5" />}
              onClick={() => {
                adminSession.clear();
                navigate('/admin/login', { replace: true });
              }}
            >
              Salir
            </Button>
          </div>
        </div>

        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">
            Personas registradas
          </h1>
          <p className="mt-1 text-sm text-surface-600">
            Solo se almacena la representación matemática del rostro, nunca la
            fotografía.
          </p>
        </header>

        {/* Alta */}
        <Card className="mb-6 p-5">
          <h2 className="mb-4 flex items-center gap-2 font-semibold">
            <UserPlus className="h-4 w-4 text-brand-600" />
            Registrar persona
          </h2>
          <form
            onSubmit={handleCreate}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <div className="flex-1">
              <Input
                name="fullName"
                label="Nombre completo"
                placeholder="Diego Ossa"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                error={formError ?? undefined}
                autoComplete="off"
              />
            </div>
            <div className="flex-1">
              <Input
                name="externalId"
                label="Identificador (opcional)"
                placeholder="Cédula o código"
                value={newExternalId}
                onChange={(e) => setNewExternalId(e.target.value)}
                autoComplete="off"
              />
            </div>
            <Button type="submit" loading={creating} className="sm:mb-0">
              Crear
            </Button>
          </form>
        </Card>

        {/* Buscador */}
        <div className="relative mb-4">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-surface-600" />
          <Input
            name="search"
            placeholder="Buscar por nombre o identificador..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Listado */}
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="flex items-center gap-4 p-4">
                <Skeleton className="h-11 w-11 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-9 w-24" />
              </Card>
            ))}
          </div>
        ) : people.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Users className="h-7 w-7" />}
              title={search ? 'Sin resultados' : 'Todavía no hay nadie'}
              description={
                search
                  ? 'Prueba con otro nombre o identificador.'
                  : 'Registra la primera persona con el formulario de arriba.'
              }
            />
          </Card>
        ) : (
          <div className="space-y-3">
            {people.map((person) => (
              <Card
                key={person.id}
                className="animate-fade-up flex flex-wrap items-center gap-4 p-4"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-500/10 font-semibold text-brand-600">
                  {person.fullName.slice(0, 1).toUpperCase()}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{person.fullName}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-surface-600">
                    {person.externalId && <span>{person.externalId}</span>}
                    <span>Alta {formatDate(person.createdAt)}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Badge
                    tone={person.status === 'ACTIVE' ? 'granted' : 'neutral'}
                  >
                    {person.status === 'ACTIVE' ? 'Activo' : 'Suspendido'}
                  </Badge>
                  <Badge
                    tone={person.enrolledFacesCount > 0 ? 'granted' : 'pending'}
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
                  </Badge>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Camera className="h-3.5 w-3.5" />}
                    onClick={() => setEnrolling(person)}
                  >
                    Capturar
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Eliminar a ${person.fullName}`}
                    loading={deletingId === person.id}
                    onClick={() => void handleDelete(person)}
                    className="text-denied hover:bg-denied/10"
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                  />
                </div>
              </Card>
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
