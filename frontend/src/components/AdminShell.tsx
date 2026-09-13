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
}: {
  title: string;
  subtitle?: ReactNode;
  /** Controles propios de la pantalla, a la derecha del encabezado. */
  actions?: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const admin = adminSession.getProfile();

  return (
    <div className="relative min-h-dvh bg-vault-bg">
      <VaultBackground />

      <div className={cn('relative z-10 mx-auto px-4 py-8', width)}>
        {/* ── Navegación superior ──────────────────────────────── */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
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
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <VaultTitle>{title}</VaultTitle>
            {subtitle && (
              <p className="mt-2 text-sm text-white/45">{subtitle}</p>
            )}
          </div>
          {actions}
        </header>

        {children}
      </div>
    </div>
  );
}
