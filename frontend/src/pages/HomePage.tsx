import {
  Clock,
  Coffee,
  DoorOpen,
  LayoutDashboard,
  LogOut,
  Mic,
  Pause,
  Play,
  Sandwich,
  Toilet,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { PendingIncidents } from '@/components/PendingIncidents';
import {
  GlassCard,
  GlowBadge,
  VaultBackground,
  VaultButton,
  VaultTitle,
  type Accent,
} from '@/components/vault';
import {
  api,
  ApiError,
  type BreakNote,
  type ShiftState,
  type ShiftSummary,
  type WorkDay,
} from '@/lib/api';
import { formatDuration, formatTime, greetingFor } from '@/lib/utils';

interface HomeState {
  name?: string;
  id?: string;
  /** Si el acceso concedido fue una entrada o una salida. */
  passage?: 'IN' | 'OUT';
}

/**
 * Descansos que se pueden declarar sin cruzar ningún lector.
 *
 * Ir al baño o bajar a por un café no pasan por ninguna puerta, y sin
 * declararlos la jornada contaría como trabajado todo el rato que se
 * pase dentro del edificio.
 */
const BREAKS: Array<{ note: BreakNote; label: string; icon: typeof Coffee }> = [
  { note: 'DESCANSO', label: 'Descanso', icon: Coffee },
  { note: 'ALMUERZO', label: 'Almuerzo', icon: Sandwich },
  { note: 'BANO', label: 'Baño', icon: Toilet },
];

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
 * Movimientos que caben sin desbordar (`max-h-72` da para unos seis).
 *
 * Solo se usa para decidir si vale la pena enseñar el total en el
 * encabezado: con cuatro entradas el numero no aporta nada, con quince
 * es la unica pista de que la lista sigue hacia abajo.
 */
const TIMELINE_VISIBLE = 6;

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

  const [shift, setShift] = useState<ShiftSummary | null>(null);
  const [today, setToday] = useState<WorkDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const timelineRef = useRef<HTMLOListElement>(null);

  /**
   * Deja la linea de tiempo abajo del todo, en lo mas reciente.
   *
   * Depende del NUMERO de entradas y no del objeto: `setToday` crea uno
   * nuevo en cada refresco -al declarar un descanso, por ejemplo- y con
   * el objeto como dependencia esto se ejecutaria en cada uno,
   * arrastrando la lista hacia abajo mientras alguien la esta leyendo.
   */
  useEffect(() => {
    const lista = timelineRef.current;
    if (lista) lista.scrollTop = lista.scrollHeight;
  }, [today?.entries.length]);

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

  /**
   * Declara un descanso o el regreso.
   *
   * Tras el cambio se recarga la línea de tiempo: el estado lo devuelve
   * la propia respuesta, pero la nueva entrada del día no, y verla
   * aparecer es lo que confirma que quedó registrado.
   */
  const changeState = async (action: () => Promise<ShiftSummary>) => {
    setChanging(true);
    setError(null);
    try {
      setShift(await action());
      const timeline = await api.myTimeline();
      setToday(timeline.items[0] ?? null);
    } catch (err) {
      // El backend explica por qué no se pudo -"ya estabas en
      // descanso", "estás fuera de la sede"- y ese mensaje es más útil
      // que uno genérico, así que se muestra tal cual.
      setError(
        err instanceof ApiError ? err.message : 'No se pudo cambiar el estado',
      );
    } finally {
      setChanging(false);
    }
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

          {/* Lo que dejó sin cerrar el turno anterior. Va aquí arriba y
              no al final porque es lo primero que hay que saber al
              empezar a trabajar, y esta pantalla se mira dos segundos. */}
          <PendingIncidents />

          {/* ── Línea de tiempo ──────────────────────────────── */}
          {/*
            LA LISTA DESBORDA POR DENTRO, NO LA PÁGINA.
            Misma regla que el panel de operación: el encabezado tiene
            que seguir visible mientras se recorre el histórico.

            Aquí además hay un motivo propio. Una jornada con descansos
            genera dos movimientos por cada café, y un turno largo pasa
            de veinte con facilidad -13 h y 15 entradas en la prueba del
            2026-09-14-. Sin tope, los botones de declarar descanso y de
            dictar el parte se van tan abajo que dejan de existir para
            quien mira esta pantalla dos segundos.

            Se abre abajo del todo y no arriba: el orden es cronológico
            y lo último que pasó es lo que importa al llegar.
          */}
          {today && today.entries.length > 0 && (
            <section className="mt-7">
              <h2 className="mb-3 flex items-baseline justify-between text-xs font-medium tracking-widest text-white/35 uppercase">
                <span>Tu jornada</span>
                {today.entries.length > TIMELINE_VISIBLE && (
                  <span className="tracking-normal normal-case">
                    {today.entries.length} movimientos
                  </span>
                )}
              </h2>
              <ol
                ref={timelineRef}
                className="max-h-72 space-y-0 overflow-y-auto pr-1"
              >
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

          {/* ── Declarar un descanso ─────────────────────────── */}
          {shift && shift.state !== 'FUERA' && (
            <section className="mt-7 border-t border-white/8 pt-5">
              {shift.state === 'EN_DESCANSO' ? (
                <VaultButton
                  tone="blue"
                  className="w-full"
                  loading={changing}
                  onClick={() => void changeState(() => api.endBreak())}
                  icon={<Play className="h-4 w-4" />}
                >
                  Volver al trabajo
                </VaultButton>
              ) : shift.state === 'EN_PAUSA' ? (
                // Está fuera del edificio: su vuelta la registra la
                // puerta. Un botón aquí sería fichar sin estar.
                <p className="text-center text-xs text-white/35">
                  Estás fuera de la sede. Vuelve a pasar por la cámara para
                  reanudar tu jornada.
                </p>
              ) : (
                <>
                  <h2 className="mb-3 text-xs font-medium tracking-widest text-white/35 uppercase">
                    Tomar un descanso
                  </h2>
                  <div className="grid grid-cols-3 gap-2">
                    {BREAKS.map((option) => (
                      <VaultButton
                        key={option.note}
                        tone="glass"
                        size="sm"
                        loading={changing}
                        onClick={() =>
                          void changeState(() => api.startBreak(option.note))
                        }
                        icon={<option.icon className="h-3.5 w-3.5" />}
                      >
                        {option.label}
                      </VaultButton>
                    ))}
                  </div>
                  <p className="mt-2 text-center text-[11px] text-white/25">
                    El tiempo de descanso no computa como jornada.
                  </p>
                </>
              )}

              {/* Dictar el parte NO es cambiar de estado: es dejar
                  constancia de lo que ha pasado. Por eso está
                  disponible en cualquier estado con jornada abierta,
                  incluido EN_PAUSA, al contrario que los descansos. */}
              <VaultButton
                tone="glass"
                className="mt-4 w-full"
                onClick={() => navigate('/relevo', { state })}
                icon={<Mic className="h-4 w-4" />}
              >
                Dictar parte de relevo
              </VaultButton>
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
        <p className="text-xs text-white/35">
          {entry.origin === 'MANUAL'
            ? 'Declarado por ti'
            : entry.origin === 'SYSTEM'
              ? 'Cerrado automáticamente'
              : entry.accessPointName}
        </p>
      </div>
    </li>
  );
}

const NOTES: Record<BreakNote, string> = {
  DESCANSO: 'Descanso',
  ALMUERZO: 'Almuerzo',
  BANO: 'Baño',
  OTRO: 'Pausa',
};

function describe(entry: WorkDay['entries'][number]): string {
  if (entry.note) return NOTES[entry.note];
  if (entry.toState === 'EN_DESCANSO') return 'Descanso';
  if (entry.toState === 'EN_PAUSA') return 'Salida temporal';
  if (entry.toState === 'FUERA') return 'Fin de jornada';
  if (entry.fromState === 'FUERA') return 'Entrada';
  if (entry.fromState === 'EN_DESCANSO' || entry.fromState === 'EN_PAUSA') {
    return 'Vuelta al trabajo';
  }
  return entry.zoneName ?? 'Movimiento';
}
