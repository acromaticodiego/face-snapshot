import { Info, Ruler } from 'lucide-react';

import { GlassCard } from '@/components/vault';
import type { SimilarityResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Distribución de similitudes: la nube de los reconocidos frente a la
 * de los desconocidos, con el umbral en uso marcado encima.
 *
 * ES EL GRAFICO QUE CONVIERTE EL UMBRAL EN UNA DECISION
 * ─────────────────────────────────────────────────────
 * El 0.38 se eligió midiendo seis rostros de fotos de archivo (ADR
 * 0003) y el README lo arrastra desde entonces como pendiente de
 * calibrar. Aquí se ve con los datos del despliegue de verdad.
 *
 * LO QUE ESTE GRAFICO NO PUEDE DECIR
 * ──────────────────────────────────
 * Tasas de error. Las dos nubes están separadas por el propio umbral
 * que se evalúa —un intento es "desconocido" precisamente porque no lo
 * alcanzó—, así que jamás se verá solapamiento por mucho que lo haya
 * en la realidad. Por eso el panel enseña **márgenes** y no
 * porcentajes de acierto, y por eso la advertencia va impresa en la
 * tarjeta y no escondida en un comentario del código.
 */

const VERDICTS = {
  HOLGADO: {
    label: 'Holgado',
    tone: 'border-vault-green/40 bg-vault-green/10 text-vault-green',
    text: 'Las dos nubes están lejos del umbral por ambos lados.',
  },
  AJUSTADO: {
    label: 'Ajustado',
    tone: 'border-vault-orange/40 bg-vault-orange/10 text-vault-orange',
    text: 'Alguna nube roza el umbral: una mala captura provoca incidente.',
  },
  SOLAPADO: {
    label: 'Solapado',
    tone: 'border-denied/40 bg-denied/10 text-denied',
    text: 'Las nubes se pisan. Ningún umbral las separa: hay que mejorar la captura.',
  },
  SIN_DATOS: {
    label: 'Sin datos',
    tone: 'border-white/20 bg-white/5 text-white/50',
    text: 'Todavía no hay muestras suficientes de las dos nubes.',
  },
} as const;

const CHART_HEIGHT = 104;

export function SimilarityChart({ data }: { data: SimilarityResponse | null }) {
  if (!data) {
    return (
      <GlassCard className="shrink-0 p-4">
        <div className="h-56 animate-pulse rounded-lg bg-white/5" />
      </GlassCard>
    );
  }

  const { analysis, threshold, recognized, unrecognized } = data;
  const verdict = VERDICTS[analysis.verdict];

  // Escala compartida por las dos nubes. Normalizar cada una a su
  // propio máximo las haría parecer del mismo tamaño y ocultaría que
  // una tiene diez veces más muestras que la otra.
  const peak = Math.max(
    1,
    ...recognized.map((b) => b.count),
    ...unrecognized.map((b) => b.count),
  );

  const first = recognized[0]?.from ?? -0.2;
  const last = recognized[recognized.length - 1]?.to ?? 1;
  const span = last - first || 1;
  const thresholdX = ((threshold - first) / span) * 100;

  return (
    <GlassCard className="shrink-0 p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Ruler className="h-4 w-4 text-vault-purple" />
          Distribución de similitudes
        </h2>
        <span
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-xs font-medium',
            verdict.tone,
          )}
        >
          Umbral {threshold} · {verdict.label}
        </span>
      </div>
      <p className="mb-3 text-[11px] leading-tight text-white/35">{verdict.text}</p>

      {/* ── Histograma ───────────────────────────────────────── */}
      <div className="relative" style={{ height: CHART_HEIGHT }}>
        <div className="absolute inset-0 flex items-end gap-px">
          {recognized.map((bucket, index) => {
            const unknown = unrecognized[index]?.count ?? 0;
            const known = bucket.count;
            return (
              <div
                key={bucket.from}
                className="relative flex-1"
                style={{ height: '100%' }}
                title={`${bucket.from.toFixed(2)} – ${bucket.to.toFixed(2)}: ${known} reconocidos, ${unknown} desconocidos`}
              >
                {/* Superpuestas y semitransparentes: en el hueco entre
                    nubes solo hay una, pero si algún día se pisan tiene
                    que verse el solapamiento y no taparlo. */}
                <Bar count={unknown} peak={peak} className="bg-denied/70" />
                <Bar count={known} peak={peak} className="bg-vault-green/80" />
              </div>
            );
          })}
        </div>

        {/* Línea del umbral en uso. */}
        <div
          className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-white/50"
          style={{ left: `${thresholdX}%` }}
          aria-hidden="true"
        >
          <span className="absolute -top-0.5 left-1 text-[10px] whitespace-nowrap text-white/50">
            {threshold}
          </span>
        </div>
      </div>

      {/* ── Eje ──────────────────────────────────────────────── */}
      <div className="mt-1 flex justify-between font-mono text-[10px] text-white/25">
        <span>{first.toFixed(1)}</span>
        <span>similitud coseno</span>
        <span>{last.toFixed(1)}</span>
      </div>

      {/* ── Lectura ──────────────────────────────────────────── */}
      <dl className="mt-3 grid grid-cols-3 gap-3 border-t border-white/8 pt-3">
        <Figure
          label="separación"
          value={analysis.separation}
          hint="entre las dos nubes"
        />
        <Figure
          label="margen abajo"
          value={analysis.marginBelow}
          hint="le faltó al extraño más cercano"
        />
        <Figure
          label="margen arriba"
          value={analysis.marginAbove}
          hint="le sobró al legítimo más justo"
        />
      </dl>

      <div className="mt-3 flex gap-4 text-[11px] text-white/40">
        <Legend className="bg-vault-green/80">
          reconocidos ({analysis.recognized.samples})
        </Legend>
        <Legend className="bg-denied/70">
          desconocidos ({analysis.unrecognized.samples})
        </Legend>
      </div>

      {/* El aviso va plegado: ocupa una linea y se abre al pulsarlo.
          Tiene que estar a la vista para que nadie lea el grafico como
          si midiera tasas de error, pero cuatro lineas de texto legal
          en un panel de operacion empujan fuera de la pantalla lo que
          si se mira a diario. */}
      <details className="group mt-3">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-white/30 hover:text-white/50">
          <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Qué NO mide este gráfico
        </summary>
        <p className="mt-2 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2 text-[11px] leading-relaxed text-white/35">
          {analysis.caveat}
        </p>
      </details>
    </GlassCard>
  );
}

function Bar({
  count,
  peak,
  className,
}: {
  count: number;
  peak: number;
  className: string;
}) {
  if (count === 0) return null;
  return (
    <div
      className={cn('absolute bottom-0 w-full rounded-t-sm', className)}
      // Mínimo de 2 px: una barra de una sola muestra debe verse, y es
      // justo la que importa cuando está pegada al umbral.
      style={{ height: `${Math.max(2, (count / peak) * CHART_HEIGHT)}px` }}
    />
  );
}

function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | null;
  hint: string;
}) {
  return (
    <div>
      <dt className="text-[11px] text-white/35">{label}</dt>
      <dd className="text-base leading-tight font-bold tracking-tight text-white tabular-nums">
        {value === null ? '—' : value.toFixed(3)}
      </dd>
      <p className="text-[10px] leading-tight text-white/25">{hint}</p>
    </div>
  );
}

function Legend({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn('h-2 w-3 rounded-sm', className)}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}
