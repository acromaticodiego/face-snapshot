import { ArrowLeft, LogIn, Lock, Mail } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import {
  GlassCard,
  GlassField,
  VaultBackground,
  VaultButton,
  VaultTitle,
} from '@/components/vault';
import { api, ApiError } from '@/lib/api';
import { adminSession } from '@/lib/auth';

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
      setError(
        err instanceof ApiError ? err.message : 'No se pudo iniciar sesión',
      );
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-dvh overflow-hidden bg-vault-bg">
      <VaultBackground />

      <Link
        to="/"
        className="absolute top-5 left-5 z-20 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-white/55 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40"
      >
        <ArrowLeft className="h-4 w-4" />
        Volver
      </Link>

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

          <div className="mb-8 text-center">
            <VaultTitle className="sm:text-4xl">
              Acceso de administración
            </VaultTitle>
            <p className="mt-2 text-sm text-white/45">
              Identifícate para gestionar las personas registradas.
            </p>
          </div>

          <GlassCard className="p-7">
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

              <VaultButton
                type="submit"
                loading={loading}
                icon={<LogIn className="h-4 w-4" />}
                className="w-full"
              >
                {loading ? 'Verificando...' : 'Entrar'}
              </VaultButton>
            </form>

            <p className="mt-6 border-t border-white/10 pt-4 text-center text-xs leading-relaxed text-white/35">
              Tras cinco intentos fallidos la cuenta se bloquea durante quince
              minutos. La sesión caduca a las ocho horas y se cierra al salir
              del navegador.
            </p>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
