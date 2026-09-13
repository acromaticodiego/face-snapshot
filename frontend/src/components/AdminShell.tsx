import { ArrowLeft, LayoutDashboard, LogOut, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { VaultBackground, VaultButton, VaultTitle } from '@/components/vault';
import { adminSession } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Marco común de las pantallas de administración.
 *
 * Existe desde que hay dos: la barra superior, el fondo y el cierre de
 * sesión estaban escritos en el panel de personas y el panel de
 * operación los necesitaba idénticos. Con dos copias, un cambio en el
 * cierre de sesión se aplicaría en una y se olvidaría en la otra.
 */

const SECTIONS = [
  { to: '/admin/dashboard', label: 'Operación', icon: LayoutDashboard },
  { to: '/admin/faces', label: 'Personas', icon: Users },
];

export function AdminShell({
  title,
  subtitle,
  actions,
  children,
  width = 'max-w-4xl',
  fill = false,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Controles propios de la pantalla, a la derecha del encabezado. */
  actions?: ReactNode;
  children: ReactNode;
  width?: string;
  /**
   * Ocupa exactamente el alto de la ventana, sin barra de
   * desplazamiento en la página.
   *
   * Es lo que quiere un panel de operación: se mira de un vistazo, y
   * cualquier dato que obligue a bajar es un dato que nadie mira. Cada
   * bloque se encarga entonces de desbordar por dentro si le hace
   * falta, en lugar de empujar al resto fuera de la pantalla.
   */
  fill?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const admin = adminSession.getProfile();

  return (
    <div
      className={cn(
        'relative bg-vault-bg',
        fill ? 'flex h-dvh flex-col overflow-hidden' : 'min-h-dvh',
      )}
    >
      <VaultBackground />

      <div
        className={cn(
          'relative z-10 mx-auto w-full px-4',
          fill ? 'flex min-h-0 flex-1 flex-col py-4' : 'py-8',
          width,
        )}
      >
        {/* ── Navegación superior ──────────────────────────────── */}
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-3',
            fill ? 'mb-3' : 'mb-8',
          )}
        >
          <div className="flex flex-wrap items-center gap-1">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-white/55 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Volver a la autenticación</span>
            </Link>

            <span className="mx-1 h-4 w-px bg-white/10" aria-hidden="true" />

            {SECTIONS.map((section) => {
              const active = location.pathname === section.to;
              return (
                <Link
                  key={section.to}
                  to={section.to}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40',
                    active
                      ? 'bg-white/10 text-white'
                      : 'text-white/55 hover:text-white',
                  )}
                >
                  <section.icon className="h-4 w-4" />
                  {section.label}
                </Link>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            {admin && (
              <span className="hidden text-sm text-white/55 sm:inline">
                {admin.displayName}
              </span>
            )}
            <VaultButton
              size="sm"
              tone="ghost"
              icon={<LogOut className="h-3.5 w-3.5" />}
              onClick={() => {
                adminSession.clear();
                navigate('/admin/login', { replace: true });
              }}
            >
              Salir
            </VaultButton>
          </div>
        </div>

        {/* ── Encabezado ───────────────────────────────────────── */}
        <header
          className={cn(
            'flex flex-wrap items-end justify-between gap-4',
            fill ? 'mb-3' : 'mb-8',
          )}
        >
          <div>
            <VaultTitle className={fill ? 'text-2xl' : undefined}>
              {title}
            </VaultTitle>
            {subtitle && (
              <p
                className={cn(
                  'text-sm text-white/45',
                  fill ? 'mt-0.5 text-xs' : 'mt-2',
                )}
              >
                {subtitle}
              </p>
            )}
          </div>
          {actions}
        </header>

        {fill ? (
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
