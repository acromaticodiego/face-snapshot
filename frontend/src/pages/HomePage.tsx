import {
  Clock,
  Coffee,
  DoorOpen,
  LayoutDashboard,
  LogOut,
  Pause,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import {
  GlassCard,
  GlowBadge,
  VaultBackground,
  VaultButton,
  VaultTitle,
  type Accent,
} from '@/components/vault';
import { api, ApiError, type ShiftState, type WorkDay } from '@/lib/api';
import { formatDuration, formatTime, greetingFor } from '@/lib/utils';

interface HomeState {
  name?: string;
  id?: string;
  /** Si el acceso concedido fue una entrada o una salida. */
  passage?: 'IN' | 'OUT';
}

/** Cómo se presenta cada estado de turno. */
const STATES: Record<
  ShiftState,
  { label: string; accent: Accent; icon: typeof Clock }
> = {
  EN_TURNO: { label: 'En turno', accent: 'green', icon: Clock },
  EN_DESCANSO: { label: 'En descanso', accent: 'orange', icon: Coffee },
  EN_PAUSA: { label: 'En pausa', accent: 'orange', icon: Pause },
  FUERA: { label: 'Jornada cerrada', accent: 'purple', icon: DoorOpen },
};

/**
 * Pantalla posterior a la autenticación.
 *
 * Muestra la jornada de quien acaba de identificarse, leída con el
 * token de sesión que emitió el Access Service. El identificador de la
 * persona NO viaja en la petición: lo deduce el Gateway del token.
 *
 * El estado de navegación (`state.name`) solo sirve para pintar el
 * nombre de inmediato, sin esperar a la red. NO es seguridad: los datos
 * de verdad los trae la API validando el token en cada petición.
 */
export function HomePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as HomeState;

  const [shift, setShift] = useState<Awaited<
    ReturnType<typeof api.myShift>
  > | null>(null);
  const [today, setToday] = useState<WorkDay | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        // En paralelo: son dos servicios distintos detrás del Gateway y
        // ninguna de las dos respuestas depende de la otra.
        const [current, timeline] = await Promise.all([
          api.myShift(),
          api.myTimeline(),
        ]);
        if (cancelled) return;
        setShift(current);
        setToday(timeline.items[0] ?? null);
      } catch (err) {
        if (cancelled) return;
        // Un fallo aquí no debe tapar la confirmación de identidad: se
        // avisa, pero la pantalla sigue diciendo a quién reconoció.
        setError(
          err instanceof ApiError
            ? err.message
            : 'No se pudo consultar tu jornada',
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // A esta pantalla solo se llega tras una autenticación correcta. Si
  // alguien escribe la URL directamente, vuelve al inicio.
  //
  // Ojo: esto es comodidad de navegación, NO seguridad. Los datos
  // sensibles los protege el token, que se valida en el backend.
  if (!state.name) {
    return <Navigate to="/" replace />;
  }

  const handleExit = () => {
    sessionStorage.removeItem('accessToken');
    navigate('/', { replace: true });
  };

  const presentation = shift ? STATES[shift.state] : null;
  const StateIcon = presentation?.icon ?? Clock;

  // Al fichar la salida no tiene sentido desear buenos días: lo que
  // importa es el resumen del día que se cierra.
  const leaving = state.passage === 'OUT';
  const heading = leaving ? 'Hasta luego' : greetingFor();
  const firstName = state.name.split(' ')[0];

  return (
    <div className="relative flex min-h-dvh items-start justify-center bg-vault-bg px-4 py-10 sm:items-center">
      <VaultBackground />

      <div className="animate-fade-up relative z-10 w-full max-w-xl">
        <header className="mb-6 text-center">
          <p className="text-xs font-medium tracking-widest text-white/40 uppercase">
            {heading}
          </p>
          <VaultTitle className="mt-1 text-balance">{firstName}</VaultTitle>
        </header>

        <GlassCard glow={presentation?.accent ?? 'green'} className="p-6 sm:p-8">
          {/* ── Estado y hora de entrada ─────────────────────── */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {presentation ? (
              <GlowBadge accent={presentation.accent}>
                <StateIcon className="h-3.5 w-3.5" />
                {presentation.label}
              </GlowBadge>
            ) : (
              <span className="h-6 w-28 animate-pulse rounded-full bg-white/10" />
            )}

            {shift?.startedAt && (
              <span className="text-sm text-white/50">
                desde las{' '}
                <span className="font-semibold text-white/80">
                  {formatTime(shift.startedAt)}
                </span>
              </span>
            )}
          </div>

          {/* ── Horas ────────────────────────────────────────── */}
          <div className="mt-7 grid grid-cols-2 gap-4">
            <Metric
              label="trabajadas"
              value={shift ? formatDuration(shift.workedSeconds) : null}
              accent="text-vault-green"
            />
            <Metric
              label="de descanso"
              value={shift ? formatDuration(shift.breakSeconds) : null}
              accent="text-vault-orange"
            />
          </div>

          {error && (
            <p className="mt-5 rounded-lg border border-denied/40 bg-denied/10 px-3 py-2 text-xs text-denied">
              {error}
            </p>
          )}

          {/* ── Línea de tiempo ──────────────────────────────── */}
          {today && today.entries.length > 0 && (
            <section className="mt-7">
              <h2 className="mb-3 text-xs font-medium tracking-widest text-white/35 uppercase">
                Tu jornada
              </h2>
              <ol className="space-y-0">
                {today.entries.map((entry, index) => (
                  <Step
                    key={`${entry.at}-${index}`}
                    entry={entry}
                    last={index === today.entries.length - 1}
                  />
                ))}
              </ol>
            </section>
          )}

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <VaultButton
              tone="glass"
              className="sm:flex-1"
              onClick={handleExit}
              icon={<LogOut className="h-4 w-4" />}
            >
              Salir
            </VaultButton>
            <VaultButton
              tone="blue"
              className="sm:flex-1"
              onClick={() => navigate('/admin/dashboard')}
              icon={<LayoutDashboard className="h-4 w-4" />}
            >
              Panel de operación
            </VaultButton>
          </div>
        </GlassCard>

        {/* El panel muestra datos de toda la plantilla, así que exige
            cuenta de administración aunque se llegue desde aquí. Se
            avisa antes de pulsar para no parecer un error. */}
        <p className="mt-4 text-center text-xs text-white/30">
          El panel de operación requiere cuenta de administración.
        </p>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | null;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-4 text-center">
      {value === null ? (
        <span className="mx-auto block h-8 w-24 animate-pulse rounded bg-white/10" />
      ) : (
        <p className={`text-2xl font-bold tracking-tight ${accent}`}>{value}</p>
      )}
      <p className="mt-1 text-xs text-white/40">{label}</p>
    </div>
  );
}

/**
 * Un momento de la jornada.
 *
 * El texto se construye a partir de la transición y no de la zona, para
 * que se lea como algo que pasó y no como un volcado de la base de
 * datos: "Vuelta al trabajo" en lugar de "OUT · Cafetería".
 */
function Step({
  entry,
  last,
}: {
  entry: WorkDay['entries'][number];
  last: boolean;
}) {
  const DOT: Record<ShiftState, string> = {
    EN_TURNO: 'bg-vault-green',
    EN_DESCANSO: 'bg-vault-orange',
    EN_PAUSA: 'bg-vault-orange',
    FUERA: 'bg-white/30',
  };

  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[entry.toState]}`}
        />
        {!last && <span className="w-px flex-1 bg-white/10" />}
      </div>

      <div className={last ? 'pb-0' : 'pb-4'}>
        <p className="text-sm text-white/80">
          <span className="font-mono text-white/45">{formatTime(entry.at)}</span>
          {'  '}
          {describe(entry)}
        </p>
        {entry.accessPointName && (
          <p className="text-xs text-white/35">{entry.accessPointName}</p>
        )}
      </div>
    </li>
  );
}

function describe(entry: WorkDay['entries'][number]): string {
  if (entry.toState === 'EN_DESCANSO') return 'Descanso';
  if (entry.toState === 'EN_PAUSA') return 'Salida temporal';
  if (entry.toState === 'FUERA') return 'Fin de jornada';
  if (entry.fromState === 'FUERA') return 'Entrada';
  if (entry.fromState === 'EN_DESCANSO' || entry.fromState === 'EN_PAUSA') {
    return 'Vuelta al trabajo';
  }
  return entry.zoneName ?? 'Movimiento';
}
