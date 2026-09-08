import { ArrowLeft, LogIn, Lock, Mail } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { api, ApiError } from '@/lib/api';
import { adminSession } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Pantalla de acceso al panel de administración.
 *
 * Es la única vista del sistema que ignora el tema claro/oscuro y se
 * dibuja siempre sobre fondo profundo: funciona como portada, y el
 * contraste de los orbes de color y el cristal esmerilado depende de un
 * fondo oscuro para leerse. En claro, el mismo diseño perdería todo su
 * sentido.
 */

type Accent = 'purple' | 'green';

const ACCENT_RING: Record<Accent, string> = {
  purple:
    'focus-within:border-vault-purple/70 focus-within:shadow-[0_0_0_1px_var(--color-vault-purple),0_0_24px_-4px_var(--color-vault-purple)]',
  green:
    'focus-within:border-vault-green/70 focus-within:shadow-[0_0_0_1px_var(--color-vault-green),0_0_24px_-4px_var(--color-vault-green)]',
};

const ACCENT_ICON: Record<Accent, string> = {
  purple: 'text-vault-purple',
  green: 'text-vault-green',
};

/** Campo de texto sobre cristal, con brillo del color del acento al enfocar. */
function GlassField({
  accent,
  icon,
  label,
  ...props
}: {
  accent: Accent;
  icon: ReactNode;
  label: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium tracking-wide text-white/60">
        {label}
      </span>
      <div
        className={cn(
          'flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3.5',
          'shadow-[inset_0_1px_0_0_rgb(255_255_255/0.08)] backdrop-blur-xl',
          'transition-all duration-200',
          ACCENT_RING[accent],
        )}
      >
        <span className={cn('shrink-0', ACCENT_ICON[accent])}>{icon}</span>
        <input
          className={cn(
            'w-full bg-transparent py-3 text-sm text-white',
            'placeholder:text-white/30 focus:outline-none',
          )}
          {...props}
        />
      </div>
    </label>
  );
}

export function AdminLoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Si llegó aquí por intentar entrar a una ruta protegida, se vuelve a
  // ella tras identificarse en lugar de dejarle en la portada.
  const from =
    (location.state as { from?: string } | null)?.from ?? '/admin/faces';

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await api.adminLogin(email.trim(), password);
      adminSession.save(result.accessToken, result.admin);
      navigate(from, { replace: true });
    } catch (err) {
      // El backend devuelve siempre el mismo mensaje, exista la cuenta o
      // no. Aquí no se añade ningún detalle que permita distinguirlo.
      setError(err instanceof ApiError ? err.message : 'No se pudo iniciar sesión');
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-dvh overflow-hidden bg-vault-bg">
      {/* ── Orbes de fondo ──────────────────────────────────────────
          Gradientes radiales muy desenfocados. Van en un contenedor
          aparte marcado como decorativo para que los lectores de
          pantalla los ignoren por completo. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div
          className="animate-orb-drift absolute -top-32 -left-24 h-[34rem] w-[34rem] rounded-full opacity-45 blur-[110px]"
          style={{
            background:
              'radial-gradient(circle, var(--color-vault-purple) 0%, transparent 68%)',
          }}
        />
        <div
          className="animate-orb-drift absolute -right-28 top-1/4 h-[30rem] w-[30rem] rounded-full opacity-35 blur-[120px]"
          style={{
            background:
              'radial-gradient(circle, var(--color-vault-orange) 0%, transparent 68%)',
            animationDelay: '-6s',
          }}
        />
        <div
          className="animate-orb-drift absolute -bottom-40 left-1/3 h-[32rem] w-[32rem] rounded-full opacity-30 blur-[120px]"
          style={{
            background:
              'radial-gradient(circle, var(--color-vault-green) 0%, transparent 68%)',
            animationDelay: '-12s',
          }}
        />
      </div>

      {/* Volver, arriba a la izquierda */}
      <Link
        to="/"
        className="absolute top-5 left-5 z-20 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-white/50 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40"
      >
        <ArrowLeft className="h-4 w-4" />
        Volver
      </Link>

      {/* ── Composición central ─────────────────────────────────── */}
      <div className="relative z-10 flex min-h-dvh items-center justify-center px-4 py-14">
        <div className="w-full max-w-md">
          {/* Aro giratorio */}
          <div className="mb-7 flex justify-center">
            <div className="relative h-28 w-28">
              <div
                className="animate-ring-spin absolute inset-0 rounded-full"
                style={{
                  background:
                    'conic-gradient(from 0deg, transparent 0%, var(--color-vault-purple) 25%, var(--color-vault-orange) 50%, var(--color-vault-green) 75%, transparent 100%)',
                  // El recorte deja solo el filo del círculo: da el aro
                  // sin necesidad de un segundo elemento encima.
                  mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
                  WebkitMask:
                    'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
                }}
              />
              <div className="absolute inset-0 rounded-full opacity-60 blur-xl">
                <div
                  className="animate-ring-spin h-full w-full rounded-full"
                  style={{
                    background:
                      'conic-gradient(from 0deg, transparent 0%, var(--color-vault-purple) 25%, var(--color-vault-orange) 50%, var(--color-vault-green) 75%, transparent 100%)',
                  }}
                />
              </div>
              <div className="absolute inset-[0.6rem] flex items-center justify-center rounded-full border border-white/10 bg-white/5 backdrop-blur-md">
                <Lock className="h-8 w-8 text-white/80" strokeWidth={1.5} />
              </div>
            </div>
          </div>

          {/* Título y subtítulo */}
          <div className="mb-8 text-center">
            <h1
              className="bg-gradient-to-r from-white via-vault-purple to-vault-orange bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl"
              style={{ paddingBottom: '0.15em' }}
            >
              Acceso de administración
            </h1>
            <p className="mt-2 text-sm text-white/45">
              Identifícate para gestionar las personas registradas.
            </p>
          </div>

          {/* Tarjeta de cristal */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-7 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.1),0_24px_60px_-20px_rgb(0_0_0/0.9)] backdrop-blur-2xl">
            <form onSubmit={handleSubmit} className="space-y-5">
              <GlassField
                accent="purple"
                icon={<Mail className="h-4 w-4" />}
                label="Correo"
                name="email"
                type="email"
                placeholder="admin@detector.local"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
                autoFocus
              />

              <GlassField
                accent="green"
                icon={<Lock className="h-4 w-4" />}
                label="Contraseña"
                name="password"
                type="password"
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />

              {error && (
                <p
                  className="rounded-xl border border-denied/30 bg-denied/10 px-3.5 py-2.5 text-sm text-denied"
                  role="alert"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                className={cn(
                  'group relative flex w-full items-center justify-center gap-2 overflow-hidden',
                  'rounded-xl bg-vault-blue py-3 text-sm font-semibold text-white',
                  'shadow-[0_8px_24px_-8px_var(--color-vault-blue)]',
                  'transition-all duration-200 active:scale-[0.99]',
                  'hover:shadow-[0_0_0_1px_var(--color-vault-orange),0_10px_30px_-8px_var(--color-vault-orange)]',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60',
                  'disabled:pointer-events-none disabled:opacity-60',
                )}
              >
                {loading ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                {loading ? 'Verificando...' : 'Entrar'}
              </button>
            </form>

            <p className="mt-6 border-t border-white/10 pt-4 text-center text-xs leading-relaxed text-white/35">
              Tras cinco intentos fallidos la cuenta se bloquea durante
              quince minutos. La sesión caduca a las ocho horas y se cierra
              al salir del navegador.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
