import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Piezas visuales de las pantallas de administración.
 *
 * Login y panel comparten estética: fondo profundo, orbes de color y
 * cristal esmerilado. Viven aquí para que un ajuste —la intensidad de
 * los orbes, el radio de las tarjetas— se aplique a las dos a la vez, en
 * lugar de tener que acordarse de cambiarlo en dos sitios.
 *
 * Estas pantallas ignoran a propósito el tema claro/oscuro y se dibujan
 * siempre sobre fondo profundo: el contraste de los orbes y del cristal
 * depende de ello, y en claro el diseño perdería su sentido.
 */

export type Accent = 'purple' | 'green' | 'orange';

const ACCENT_FOCUS: Record<Accent, string> = {
  purple:
    'focus-within:border-vault-purple/70 focus-within:shadow-[0_0_0_1px_var(--color-vault-purple),0_0_24px_-4px_var(--color-vault-purple)]',
  green:
    'focus-within:border-vault-green/70 focus-within:shadow-[0_0_0_1px_var(--color-vault-green),0_0_24px_-4px_var(--color-vault-green)]',
  orange:
    'focus-within:border-vault-orange/70 focus-within:shadow-[0_0_0_1px_var(--color-vault-orange),0_0_24px_-4px_var(--color-vault-orange)]',
};

const ACCENT_TEXT: Record<Accent, string> = {
  purple: 'text-vault-purple',
  green: 'text-vault-green',
  orange: 'text-vault-orange',
};

/**
 * Fondo con orbes.
 *
 * Va en un contenedor decorativo marcado como aria-hidden: son puro
 * adorno y no deben aparecer en un lector de pantalla.
 */
export function VaultBackground() {
  return (
    <div className="pointer-events-none fixed inset-0" aria-hidden="true">
      <div
        className="animate-orb-drift absolute -top-32 -left-24 h-[34rem] w-[34rem] rounded-full opacity-40 blur-[110px]"
        style={{
          background:
            'radial-gradient(circle, var(--color-vault-purple) 0%, transparent 68%)',
        }}
      />
      <div
        className="animate-orb-drift absolute top-1/4 -right-28 h-[30rem] w-[30rem] rounded-full opacity-30 blur-[120px]"
        style={{
          background:
            'radial-gradient(circle, var(--color-vault-orange) 0%, transparent 68%)',
          animationDelay: '-6s',
        }}
      />
      <div
        className="animate-orb-drift absolute -bottom-40 left-1/3 h-[32rem] w-[32rem] rounded-full opacity-25 blur-[120px]"
        style={{
          background:
            'radial-gradient(circle, var(--color-vault-green) 0%, transparent 68%)',
          animationDelay: '-12s',
        }}
      />
    </div>
  );
}

/** Título con degradado blanco → morado → naranja. */
export function VaultTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h1
      className={cn(
        'bg-gradient-to-r from-white via-vault-purple to-vault-orange',
        'bg-clip-text text-transparent',
        'text-3xl font-bold tracking-tight',
        className,
      )}
      // Sin este relleno inferior, los trazos descendentes (g, j, p) se
      // recortan al aplicar bg-clip-text.
      style={{ paddingBottom: '0.15em' }}
    >
      {children}
    </h1>
  );
}

/** Tarjeta de cristal esmerilado. */
export function GlassCard({
  children,
  className,
  glow,
}: {
  children: ReactNode;
  className?: string;
  /** Añade un halo de color al borde. Para destacar una sección. */
  glow?: Accent;
}) {
  const GLOW: Record<Accent, string> = {
    purple: 'shadow-[0_0_0_1px_rgb(255_255_255/0.06),0_0_40px_-16px_var(--color-vault-purple)]',
    green: 'shadow-[0_0_0_1px_rgb(255_255_255/0.06),0_0_40px_-16px_var(--color-vault-green)]',
    orange: 'shadow-[0_0_0_1px_rgb(255_255_255/0.06),0_0_40px_-16px_var(--color-vault-orange)]',
  };

  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-2xl',
        glow
          ? GLOW[glow]
          : 'shadow-[inset_0_1px_0_0_rgb(255_255_255/0.08)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Campo de texto sobre cristal, con brillo del acento al enfocar. */
export function GlassField({
  accent,
  icon,
  label,
  error,
  className,
  ...props
}: {
  accent: Accent;
  icon?: ReactNode;
  label?: string;
  error?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1.5 block text-xs font-medium tracking-wide text-white/60">
          {label}
        </span>
      )}
      <div
        className={cn(
          'flex items-center gap-3 rounded-xl border bg-white/5 px-3.5',
          'shadow-[inset_0_1px_0_0_rgb(255_255_255/0.08)] backdrop-blur-xl',
          'transition-all duration-200',
          error ? 'border-denied/60' : 'border-white/10',
          ACCENT_FOCUS[accent],
          className,
        )}
      >
        {icon && (
          <span className={cn('shrink-0', ACCENT_TEXT[accent])}>{icon}</span>
        )}
        <input
          className="w-full bg-transparent py-3 text-sm text-white placeholder:text-white/30 focus:outline-none"
          aria-invalid={Boolean(error)}
          {...props}
        />
      </div>
      {error && <p className="mt-1.5 text-xs text-denied">{error}</p>}
    </label>
  );
}

/** Botón azul con halo naranja al pasar por encima. */
export function VaultButton({
  children,
  loading,
  icon,
  size = 'md',
  tone = 'blue',
  className,
  ...props
}: {
  loading?: boolean;
  icon?: ReactNode;
  size?: 'sm' | 'md';
  tone?: 'blue' | 'ghost' | 'danger' | 'glass';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const TONES = {
    blue: cn(
      'bg-vault-blue text-white shadow-[0_8px_24px_-8px_var(--color-vault-blue)]',
      'hover:shadow-[0_0_0_1px_var(--color-vault-orange),0_10px_30px_-8px_var(--color-vault-orange)]',
    ),
    ghost: 'text-white/60 hover:bg-white/10 hover:text-white',
    glass: cn(
      'border border-white/12 bg-white/[0.06] text-white backdrop-blur-xl',
      'shadow-[inset_0_1px_0_0_rgb(255_255_255/0.08)]',
      'hover:border-vault-green/60 hover:shadow-[0_0_0_1px_var(--color-vault-green),0_0_28px_-8px_var(--color-vault-green)]',
    ),
    danger:
      'text-denied hover:bg-denied/15 hover:shadow-[0_0_0_1px_var(--color-denied)]',
  };

  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold',
        'transition-all duration-200 active:scale-[0.98]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60',
        'disabled:pointer-events-none disabled:opacity-60',
        size === 'sm' ? 'h-9 px-3 text-xs' : 'h-11 px-5 text-sm',
        TONES[tone],
        className,
      )}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}

/** Insignia con resplandor de color. */
export function GlowBadge({
  accent,
  children,
}: {
  accent: Accent;
  children: ReactNode;
}) {
  const STYLES: Record<Accent, string> = {
    green:
      'border-vault-green/40 bg-vault-green/10 text-vault-green shadow-[0_0_16px_-6px_var(--color-vault-green)]',
    orange:
      'border-vault-orange/40 bg-vault-orange/10 text-vault-orange shadow-[0_0_16px_-6px_var(--color-vault-orange)]',
    purple:
      'border-vault-purple/40 bg-vault-purple/10 text-vault-purple shadow-[0_0_16px_-6px_var(--color-vault-purple)]',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        STYLES[accent],
      )}
    >
      {children}
    </span>
  );
}

/** Píldora de encabezado con borde tenue y halo de color. */
export function VaultPill({
  icon,
  children,
  accent = 'purple',
}: {
  icon?: ReactNode;
  children: ReactNode;
  accent?: Accent;
}) {
  const GLOW: Record<Accent, string> = {
    purple:
      'border-vault-purple/40 text-vault-purple shadow-[0_0_20px_-8px_var(--color-vault-purple)]',
    green:
      'border-vault-green/40 text-vault-green shadow-[0_0_20px_-8px_var(--color-vault-green)]',
    orange:
      'border-vault-orange/40 text-vault-orange shadow-[0_0_20px_-8px_var(--color-vault-orange)]',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border bg-white/[0.06] px-3 py-1',
        'text-xs font-medium backdrop-blur-xl',
        GLOW[accent],
      )}
    >
      {icon}
      {children}
    </span>
  );
}
