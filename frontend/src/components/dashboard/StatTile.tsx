import type { LucideIcon } from 'lucide-react';

import { GlassCard, type Accent } from '@/components/vault';
import { cn } from '@/lib/utils';

const ACCENT_TEXT: Record<Accent, string> = {
  green: 'text-vault-green',
  orange: 'text-vault-orange',
  purple: 'text-vault-purple',
};

/**
 * Una cifra grande con su etiqueta.
 *
 * `value` acepta `undefined` para el estado de carga: con un cero
 * mientras llega la respuesta, el panel diría durante un instante que
 * no hay nadie en el edificio, que es una afirmación y no una espera.
 */
export function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: number | undefined;
  hint?: string;
  accent: Accent;
}) {
  return (
    <GlassCard className="p-4">
      <div className="flex items-center gap-2">
        <Icon className={cn('h-4 w-4', ACCENT_TEXT[accent])} aria-hidden="true" />
        <span className="text-xs font-medium text-white/50">{label}</span>
      </div>

      {value === undefined ? (
        <span className="mt-2 block h-9 w-14 animate-pulse rounded bg-white/10" />
      ) : (
        <p className="mt-1 text-3xl font-bold tracking-tight text-white tabular-nums">
          {value}
        </p>
      )}

      {hint && <p className="mt-1 text-[11px] text-white/30">{hint}</p>}
    </GlassCard>
  );
}
