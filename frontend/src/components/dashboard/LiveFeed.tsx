import { ArrowDownLeft, ArrowUpRight, Radio, ShieldAlert } from 'lucide-react';

import { GlassCard } from '@/components/vault';
import type { AccessLogRow, AccessReason } from '@/lib/api';
import { cn, formatTime } from '@/lib/utils';

/**
 * Texto de cada motivo, en lenguaje de operador y no de base de datos.
 *
 * Es un `Record` completo a propósito: si mañana se añade un motivo al
 * enum y no se traduce aquí, TypeScript no compila. Un feed que muestra
 * `ANTIPASSBACK_VIOLATION` en crudo es un feed que nadie lee.
 */
const REASONS: Record<AccessReason, string> = {
  GRANTED: 'Acceso concedido',
  BELOW_THRESHOLD: 'Rostro no reconocido',
  NO_FACE_DETECTED: 'Sin rostro en el encuadre',
  MULTIPLE_FACES: 'Varias personas en el encuadre',
  LOW_QUALITY: 'Captura de baja calidad',
  INSUFFICIENT_VOTES: 'Verificación incompleta',
  PERSON_SUSPENDED: 'Persona suspendida',
  NO_ROLE_ASSIGNED: 'Sin rol asignado',
  NO_PERMISSION_FOR_ZONE: 'Sin permiso en la zona',
  OUTSIDE_SCHEDULE: 'Fuera de horario',
  ASSIGNMENT_EXPIRED: 'Asignación caducada',
  ACCESS_POINT_DISABLED: 'Puerta no disponible',
  ANTIPASSBACK_VIOLATION: 'Ya constaba dentro',
};

const ANOMALIES: Record<'ANTIPASSBACK_SOFT' | 'DUPLICATE_PASSAGE', string> = {
  ANTIPASSBACK_SOFT: 'presencia descuadrada, corregida',
  DUPLICATE_PASSAGE: 'lectura repetida, no contada',
};

export function LiveFeed({ logs }: { logs: AccessLogRow[] | null }) {
  return (
    <GlassCard className="p-5">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
        <Radio className="h-4 w-4 text-vault-green" />
        Actividad reciente
      </h2>

      {logs === null ? (
        <ul className="space-y-2" aria-label="Cargando actividad">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="h-12 animate-pulse rounded-lg bg-white/5" />
          ))}
        </ul>
      ) : logs.length === 0 ? (
        <p className="py-6 text-center text-sm text-white/40">
          Todavía no hay intentos registrados.
        </p>
      ) : (
        <ul className="divide-y divide-white/6">
          {logs.map((log) => (
            <Row key={log.id} log={log} />
          ))}
        </ul>
      )}
    </GlassCard>
  );
}

function Row({ log }: { log: AccessLogRow }) {
  const granted = log.authenticated;
  const Direction = log.direction === 'OUT' ? ArrowUpRight : ArrowDownLeft;

  return (
    <li className="flex items-center gap-3 py-2.5">
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
          granted
            ? 'border-vault-green/35 bg-vault-green/10 text-vault-green'
            : 'border-denied/35 bg-denied/10 text-denied',
        )}
      >
        {granted ? (
          <Direction className="h-4 w-4" aria-hidden="true" />
        ) : (
          <ShieldAlert className="h-4 w-4" aria-hidden="true" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white/85">
          {/* El nombre es null cuando no se reconoció a nadie, y decir
              "Desconocido" es más honesto que dejar el hueco vacío. */}
          {log.personName ?? 'Desconocido'}
          {log.anomaly && (
            <span className="ml-2 text-xs text-vault-orange">
              · {ANOMALIES[log.anomaly]}
            </span>
          )}
        </p>
        <p className="truncate text-xs text-white/40">
          {REASONS[log.reason]}
          {log.accessPointName && ` · ${log.accessPointName}`}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p className="font-mono text-xs text-white/45">
          {formatTime(log.createdAt)}
        </p>
        {/* La similitud solo se muestra cuando hubo una comparación real:
            en un "varias personas en el encuadre" vale cero porque nunca
            se llegó a comparar nada, y enseñar ese cero sugeriría un
            parecido nulo en lugar de una comparación que no ocurrió. */}
        {(log.personId !== null || log.reason === 'BELOW_THRESHOLD') && (
          <p className="font-mono text-[11px] text-white/25 tabular-nums">
            {log.confidence.toFixed(2)}
          </p>
        )}
      </div>
    </li>
  );
}
