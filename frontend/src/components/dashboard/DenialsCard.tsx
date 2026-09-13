import { ShieldX } from 'lucide-react';

import { GlassCard } from '@/components/vault';
import type { AccessReason, DenialsResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Denegaciones agrupadas por motivo.
 *
 * LA SEPARACION QUE ENSEÑA ESTE GRAFICO
 * ─────────────────────────────────────
 * "No te reconozco" y "te reconozco pero no puedes pasar" son
 * incidentes distintos, y se investigan de forma distinta: el primero
 * apunta a la cámara, la luz o el enrolamiento; el segundo, a los
 * permisos o al horario. El enum los distingue desde la fase anterior y
 * aquí es donde por fin se ve, con un color para cada familia.
 */

type Family = 'identidad' | 'permisos' | 'operacion';

const FAMILY: Record<AccessReason, Family> = {
  GRANTED: 'operacion',
  BELOW_THRESHOLD: 'identidad',
  NO_FACE_DETECTED: 'identidad',
  MULTIPLE_FACES: 'identidad',
  LOW_QUALITY: 'identidad',
  INSUFFICIENT_VOTES: 'identidad',
  PERSON_SUSPENDED: 'permisos',
  NO_ROLE_ASSIGNED: 'permisos',
  NO_PERMISSION_FOR_ZONE: 'permisos',
  OUTSIDE_SCHEDULE: 'permisos',
  ASSIGNMENT_EXPIRED: 'permisos',
  ACCESS_POINT_DISABLED: 'operacion',
  ANTIPASSBACK_VIOLATION: 'operacion',
};

const LABELS: Record<AccessReason, string> = {
  GRANTED: 'Concedido',
  BELOW_THRESHOLD: 'No reconocido',
  NO_FACE_DETECTED: 'Sin rostro',
  MULTIPLE_FACES: 'Varias personas',
  LOW_QUALITY: 'Baja calidad',
  INSUFFICIENT_VOTES: 'Verificación incompleta',
  PERSON_SUSPENDED: 'Persona suspendida',
  NO_ROLE_ASSIGNED: 'Sin rol asignado',
  NO_PERMISSION_FOR_ZONE: 'Sin permiso en la zona',
  OUTSIDE_SCHEDULE: 'Fuera de horario',
  ASSIGNMENT_EXPIRED: 'Asignación caducada',
  ACCESS_POINT_DISABLED: 'Puerta no disponible',
  ANTIPASSBACK_VIOLATION: 'Ya constaba dentro',
};

const BAR: Record<Family, string> = {
  identidad: 'bg-vault-purple',
  permisos: 'bg-vault-orange',
  operacion: 'bg-white/40',
};

const LEGEND: Array<{ family: Family; text: string }> = [
  { family: 'identidad', text: 'No se reconoció a la persona' },
  { family: 'permisos', text: 'Reconocida, pero sin permiso' },
  { family: 'operacion', text: 'Estado del sistema' },
];

export function DenialsCard({ denials }: { denials: DenialsResponse | null }) {
  if (!denials) {
    return (
      <GlassCard className="flex-1 p-4">
        <div className="h-full min-h-32 animate-pulse rounded-lg bg-white/5" />
      </GlassCard>
    );
  }

  const total = denials.granted + denials.denied;
  const worst = Math.max(1, ...denials.byReason.map((row) => row.count));

  return (
    <GlassCard className="flex min-h-0 flex-1 flex-col p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
        <ShieldX className="h-4 w-4 text-vault-orange" />
        Denegaciones
      </h2>
      <p className="mb-3 text-[11px] text-white/35">
        {denials.denied} de {total} intentos en los últimos 7 días
        {denials.anomalies > 0 && ` · ${denials.anomalies} con anomalía`}
      </p>

      {denials.byReason.length === 0 ? (
        <p className="py-4 text-sm text-white/40">
          Ningún intento denegado en el periodo.
        </p>
      ) : (
        <>
          <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {denials.byReason.map((row) => (
              <li key={row.reason}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs text-white/60">
                    {LABELS[row.reason] ?? row.reason}
                  </span>
                  <span className="text-xs font-semibold text-white tabular-nums">
                    {row.count}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
                  <div
                    className={cn(
                      'h-full rounded-full',
                      BAR[FAMILY[row.reason] ?? 'operacion'],
                    )}
                    style={{ width: `${(row.count / worst) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>

          <ul className="mt-3 shrink-0 space-y-0.5 border-t border-white/8 pt-2">
            {LEGEND.map((item) => (
              <li
                key={item.family}
                className="flex items-center gap-2 text-[11px] text-white/35"
              >
                <span
                  className={cn('h-1.5 w-4 rounded-full', BAR[item.family])}
                  aria-hidden="true"
                />
                {item.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </GlassCard>
  );
}
