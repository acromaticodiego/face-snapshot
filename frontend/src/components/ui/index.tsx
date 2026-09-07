import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/* ── Botón ─────────────────────────────────────────────────────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-700 shadow-sm shadow-brand-600/25',
  secondary:
    'bg-surface-200 text-surface-800 hover:bg-surface-300 dark:bg-surface-800 dark:text-surface-100 dark:hover:bg-surface-700',
  ghost:
    'text-surface-700 hover:bg-surface-200 dark:text-surface-300 dark:hover:bg-surface-800',
  danger:
    'bg-denied text-white hover:bg-denied-dim shadow-sm shadow-denied/25',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2.5',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium',
        'transition-all duration-150 active:scale-[0.98]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

/* ── Tarjeta ───────────────────────────────────────────────────── */

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-card border border-surface-200 bg-white shadow-sm',
        'dark:border-surface-800 dark:bg-surface-900',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── Insignia de estado ────────────────────────────────────────── */

type BadgeTone = 'neutral' | 'granted' | 'denied' | 'pending';

const TONES: Record<BadgeTone, string> = {
  neutral:
    'bg-surface-200 text-surface-700 dark:bg-surface-800 dark:text-surface-300',
  granted: 'bg-granted/15 text-granted-dim dark:text-granted',
  denied: 'bg-denied/15 text-denied-dim dark:text-denied',
  pending: 'bg-pending/15 text-pending',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Campo de texto ────────────────────────────────────────────── */

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export function Input({ label, hint, error, className, id, ...props }: InputProps) {
  const inputId = id ?? props.name;
  return (
    <div className="space-y-1.5">
      {label && (
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-surface-700 dark:text-surface-300"
        >
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={cn(
          'w-full rounded-lg border bg-white px-3 py-2 text-sm',
          'placeholder:text-surface-600/60',
          'focus:border-brand-500 focus:outline-2 focus:outline-offset-0 focus:outline-brand-500/30',
          'dark:bg-surface-950 dark:text-surface-100',
          error
            ? 'border-denied'
            : 'border-surface-300 dark:border-surface-700',
          className,
        )}
        aria-invalid={Boolean(error)}
        {...props}
      />
      {error ? (
        <p className="text-xs text-denied">{error}</p>
      ) : hint ? (
        <p className="text-xs text-surface-600 dark:text-surface-600">{hint}</p>
      ) : null}
    </div>
  );
}

/* ── Esqueleto de carga ────────────────────────────────────────── */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-md bg-surface-200 dark:bg-surface-800',
        className,
      )}
    />
  );
}

/* ── Estado vacío ──────────────────────────────────────────────── */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="rounded-full bg-surface-200 p-4 text-surface-600 dark:bg-surface-800">
        {icon}
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold text-surface-800 dark:text-surface-200">
          {title}
        </h3>
        <p className="max-w-sm text-sm text-surface-600">{description}</p>
      </div>
      {action}
    </div>
  );
}
