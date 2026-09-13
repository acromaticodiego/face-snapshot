import { CalendarClock } from 'lucide-react';

import { GlassCard } from '@/components/vault';
import type { HourlyResponse } from '@/lib/api';

/**
 * Actividad por día de la semana y hora.
 *
 * Enseña de un vistazo los picos de entrada y de salida, y sobre todo
 * lo que no debería estar ahí: actividad de madrugada o en fin de
 * semana. Un intento a las tres de la mañana no dice nada por sí solo;
 * una columna entera a las tres de la mañana, sí.
 *
 * LA HORA ES LA DE LA SEDE, NO LA DEL SERVIDOR
 * ────────────────────────────────────────────
 * Los accesos se guardan en UTC. Con el backend en un contenedor y la
 * sede en Bogotá, el pico real de las 08:00 aparecería a las 13:00 y el
 * mapa no significaría nada. La conversión la hace PostgreSQL con la
 * zona de la sede, y la tarjeta la muestra para que se sepa cuál se usó.
 */

/** Lunes primero: es como se lee una semana en español. */
const WEEKDAYS = [
  { index: 1, label: 'L' },
  { index: 2, label: 'M' },
  { index: 3, label: 'X' },
  { index: 4, label: 'J' },
  { index: 5, label: 'V' },
  { index: 6, label: 'S' },
  { index: 0, label: 'D' },
];

const FULL_DAYS: Record<number, string> = {
  0: 'domingo',
  1: 'lunes',
  2: 'martes',
  3: 'miércoles',
  4: 'jueves',
  5: 'viernes',
  6: 'sábado',
};

export function HourlyHeatmap({ data }: { data: HourlyResponse | null }) {
  if (!data) {
    return (
      <GlassCard className="p-5">
        <div className="h-48 animate-pulse rounded-lg bg-white/5" />
      </GlassCard>
    );
  }

  const byCell = new Map(
    data.cells.map((cell) => [`${cell.weekday}-${cell.hour}`, cell]),
  );
  const busiest = Math.max(1, ...data.cells.map((cell) => cell.total));

  return (
    <GlassCard className="p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <CalendarClock className="h-4 w-4 text-vault-blue" />
          Actividad por hora
        </h2>
        <span className="font-mono text-[11px] text-white/30">
          {data.timezone}
        </span>
      </div>
      <p className="mb-4 text-xs text-white/35">
        Intentos de acceso en las últimas cuatro semanas, en hora local de
        la sede.
      </p>

      <div className="overflow-x-auto">
        <div className="min-w-[34rem]">
          {/* ── Horas ────────────────────────────────────────── */}
          <div className="mb-1 flex gap-px pl-5">
            {Array.from({ length: 24 }, (_, hour) => (
              <span
                key={hour}
                className="flex-1 text-center font-mono text-[9px] text-white/25"
              >
                {/* Solo las horas pares: con 24 etiquetas se solapan. */}
                {hour % 2 === 0 ? String(hour).padStart(2, '0') : ''}
              </span>
            ))}
          </div>

          {/* ── Cuadrícula ───────────────────────────────────── */}
          {WEEKDAYS.map((day) => (
            <div key={day.index} className="mb-px flex items-center gap-px">
              <span className="w-5 shrink-0 font-mono text-[10px] text-white/30">
                {day.label}
              </span>
              {Array.from({ length: 24 }, (_, hour) => {
                const cell = byCell.get(`${day.index}-${hour}`);
                return (
                  <Cell
                    key={hour}
                    total={cell?.total ?? 0}
                    granted={cell?.granted ?? 0}
                    busiest={busiest}
                    title={`${FULL_DAYS[day.index]} a las ${String(hour).padStart(2, '0')}:00 — ${
                      cell
                        ? `${cell.total} intentos, ${cell.granted} concedidos`
                        : 'sin actividad'
                    }`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2 text-[11px] text-white/35">
        <span>menos</span>
        {[0, 0.25, 0.5, 0.75, 1].map((level) => (
          <span
            key={level}
            className="h-3 w-5 rounded-sm bg-vault-blue"
            style={{ opacity: level === 0 ? 0.06 : 0.2 + level * 0.8 }}
            aria-hidden="true"
          />
        ))}
        <span>más</span>
        <span className="ml-auto">
          {data.cells.reduce((total, cell) => total + cell.total, 0)} intentos
        </span>
      </div>
    </GlassCard>
  );
}

function Cell({
  total,
  granted,
  busiest,
  title,
}: {
  total: number;
  granted: number;
  busiest: number;
  title: string;
}) {
  // Raíz cuadrada en vez de proporción directa: con un pico de entrada
  // que multiplica por veinte al resto, la escala lineal dejaría todo
  // lo demás indistinguible del vacío.
  const intensity = total === 0 ? 0 : Math.sqrt(total / busiest);

  // Una celda donde se deniega casi todo se tiñe de rojo aunque tenga
  // poca actividad: es justo lo que hay que ver en un panel de
  // seguridad, y con un solo color pasaría desapercibida.
  const mostlyDenied = total >= 3 && granted / total < 0.34;

  return (
    <span
      title={title}
      className={`h-4 flex-1 rounded-sm ${
        mostlyDenied ? 'bg-denied' : 'bg-vault-blue'
      }`}
      style={{ opacity: total === 0 ? 0.06 : 0.2 + intensity * 0.8 }}
    />
  );
}
