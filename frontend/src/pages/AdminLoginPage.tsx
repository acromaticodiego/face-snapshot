import { ArrowLeft, LogIn, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { Button, Card, Input } from '@/components/ui';
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
        err instanceof ApiError
          ? err.message
          : 'No se pudo iniciar sesión',
      );
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-surface-100 to-surface-200 px-4 dark:from-surface-950 dark:to-surface-900">
      <div className="w-full max-w-sm">
        <Link
          to="/"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-surface-600 transition-colors hover:text-brand-600"
        >
          <ArrowLeft className="h-4 w-4" />
          Volver
        </Link>

        <Card className="animate-fade-up p-7">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-500/10">
              <ShieldCheck className="h-6 w-6 text-brand-600" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">
              Acceso de administración
            </h1>
            <p className="mt-1 text-sm text-surface-600">
              Identifícate para gestionar las personas registradas.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              name="email"
              type="email"
              label="Correo"
              placeholder="admin@detector.local"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              autoFocus
            />
            <Input
              name="password"
              type="password"
              label="Contraseña"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />

            {error && (
              <p
                className="rounded-lg bg-denied/10 px-3 py-2 text-sm text-denied-dim dark:text-denied"
                role="alert"
              >
                {error}
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              loading={loading}
              icon={<LogIn className="h-4 w-4" />}
            >
              Entrar
            </Button>
          </form>
        </Card>

        <p className="mt-4 text-center text-xs text-surface-600">
          Tras varios intentos fallidos la cuenta se bloquea
          temporalmente.
        </p>
      </div>
    </div>
  );
}
