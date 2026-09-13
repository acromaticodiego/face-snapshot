import { Activity, Building2, Coffee, Pause, RefreshCw, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminShell } from '@/components/AdminShell';
import { DenialsCard } from '@/components/dashboard/DenialsCard';
import { HourlyHeatmap } from '@/components/dashboard/HourlyHeatmap';
import { LiveFeed } from '@/components/dashboard/LiveFeed';
import { SimilarityChart } from '@/components/dashboard/SimilarityChart';
import { StatTile } from '@/components/dashboard/StatTile';
import { GlassCard } from '@/components/vault';
import {
  api,
  ApiError,
  type AccessLogRow,
  type DenialsResponse,
  type HourlyResponse,
  type OpenShiftsResponse,
  type PresenceResponse,
  type SimilarityResponse,
} from '@/lib/api';
import { cn } from '@/lib/utils';

/** Cada cuánto se refresca el panel. */
const REFRESH_MS = 5_000;

interface Snapshot {
  presence: PresenceResponse;
  shifts: OpenShiftsResponse;
  logs: AccessLogRow[];
  denials: DenialsResponse;
}

/**
 * Los dos análisis se cargan UNA vez, no en cada refresco.
 *
 * Miran semanas de historia: sondearlos cada cinco segundos seria
 * lanzar un agregado sobre toda la tabla doce veces por minuto para
 * ver cambiar el ultimo decimal. Lo que cambia a ritmo de segundos es
 * el aforo y el feed, no la distribucion de un mes.
 */
interface Analysis {
  similarity: SimilarityResponse;
  hourly: HourlyResponse;
}

/**
 * Panel de operación.
 *
 * POR QUE SONDEO Y NO UN FLUJO EN VIVO
 * ────────────────────────────────────
 * Un stream de verdad obligaría al Gateway a mantener una conexión
 * abierta por pestaña y a reenviar el bus hacia el navegador. Para un
 * panel que se mira de reojo, cinco segundos de retraso no cambian
 * ninguna decisión, y a cambio no hay conexiones colgadas que gestionar
 * ni reconexiones que depurar.
 *
 * DOS FUENTES QUE PUEDEN DISCREPAR, Y ESTA BIEN
 * ─────────────────────────────────────────────
 * El aforo viene del Access Service —el hecho físico, escrito en la
 * misma transacción que la concesión— y los estados de turno del Shift
 * Service, que los proyecta desde los eventos con unos segundos de
 * retraso. Que no cuadren durante un instante no es un fallo: es la
 * diferencia entre lo que abre una puerta y una hoja de horas.
 */
export function AdminDashboardPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  // Evita pintar una respuesta que llega después de desmontar, y que
  // dos vueltas solapadas se pisen si la red va lenta.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);

    try {
      const [presence, shifts, logs, denials] = await Promise.all([
        api.presence(),
        api.openShifts(),
        api.accessLogs(15),
        api.denialStats(7),
      ]);
      setData({ presence, shifts, logs: logs.items, denials });
      setUpdatedAt(new Date());
      setError(null);
    } catch (err) {
      // Se conserva lo último bueno en pantalla: un panel que se vacía
      // con cada hipo de la red es peor que uno que avisa de que los
      // datos son de hace unos segundos.
      setError(
        err instanceof ApiError ? err.message : 'No se pudo actualizar el panel',
      );
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [similarity, hourly] = await Promise.all([
          api.similarityStats(30),
          api.hourlyStats(28),
        ]);
        if (!cancelled) setAnalysis({ similarity, hourly });
      } catch {
        // Sin ruido: el aviso de red ya lo da el bloque principal, y
        // dos mensajes por el mismo corte solo estorban.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const counts = data?.shifts.countsByState ?? {};

  return (
    <AdminShell
      width="max-w-6xl"
      title="Panel de operación"
      subtitle="Quién está dentro ahora mismo y qué ha pasado en las puertas."
      actions={
        <div className="flex items-center gap-3 text-xs text-white/40">
          {updatedAt && <span>Actualizado {updatedAt.toLocaleTimeString('es')}</span>}
          <RefreshCw
            className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')}
            aria-hidden="true"
          />
        </div>
      }
    >
      {error && (
        <p
          role="status"
          className="mb-6 rounded-xl border border-denied/40 bg-denied/10 px-4 py-3 text-sm text-denied"
        >
          {error}
        </p>
      )}

      {/* ── Aforo y estados ──────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          icon={Users}
          accent="green"
          label="Personas dentro"
          value={data?.presence.totalPeople}
          hint="Personas distintas, no pasos"
        />
        <StatTile
          icon={Activity}
          accent="green"
          label="En turno"
          value={counts.EN_TURNO ?? 0}
        />
        <StatTile
          icon={Coffee}
          accent="orange"
          label="En descanso"
          value={counts.EN_DESCANSO ?? 0}
        />
        <StatTile
          icon={Pause}
          accent="orange"
          label="En pausa"
          value={counts.EN_PAUSA ?? 0}
          hint="Salieron y aún pueden volver"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <LiveFeed logs={data?.logs ?? null} />
        </div>

        <div className="space-y-6 lg:col-span-2">
          <DenialsCard denials={data?.denials ?? null} />
          <OccupancyByZone
            presence={data?.presence ?? null}
            shifts={data?.shifts ?? null}
          />
        </div>
      </div>

      {/* ── Analisis: cambia despacio, se carga una vez ──────── */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SimilarityChart data={analysis?.similarity ?? null} />
        <HourlyHeatmap data={analysis?.hourly ?? null} />
      </div>
    </AdminShell>
  );
}

/** Aforo por zona. */
function OccupancyByZone({
  presence,
  shifts,
}: {
  presence: PresenceResponse | null;
  shifts: OpenShiftsResponse | null;
}) {
  if (!presence) {
    return (
      <GlassCard className="p-5">
        <div className="h-24 animate-pulse rounded-lg bg-white/5" />
      </GlassCard>
    );
  }

  const zones = Object.entries(presence.occupancyByZone).sort(
    (a, b) => b[1].count - a[1].count,
  );
  const busiest = Math.max(1, ...zones.map(([, zone]) => zone.count));

  return (
    <GlassCard className="p-5">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
        <Building2 className="h-4 w-4 text-vault-blue" />
        Aforo por zona
      </h2>

      {zones.length === 0 ? (
        <p className="text-sm text-white/40">
          No hay nadie dentro en este momento.
        </p>
      ) : (
        <ul className="space-y-3">
          {zones.map(([zoneId, zone]) => (
            <li key={zoneId}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-white/60">
                  {zone.zoneName}
                </span>
                <span className="text-sm font-semibold text-white tabular-nums">
                  {zone.count}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
                <div
                  className="h-full rounded-full bg-vault-green"
                  style={{ width: `${(zone.count / busiest) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {shifts && shifts.items.length > 0 && (
        <p className="mt-4 border-t border-white/8 pt-3 text-xs text-white/35">
          {shifts.items.length} jornada
          {shifts.items.length === 1 ? '' : 's'} abierta
          {shifts.items.length === 1 ? '' : 's'}
        </p>
      )}
    </GlassCard>
  );
}
