import { CheckCircle2, LogOut } from 'lucide-react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { Button, Card } from '@/components/ui';

interface WelcomeState {
  name?: string;
  id?: string;
}

/**
 * Pantalla posterior a la autenticación.
 *
 * De momento solo da la bienvenida, según lo acordado. El contenido real
 * se definirá más adelante.
 */
export function WelcomePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as WelcomeState;

  // A esta pantalla solo se llega tras una autenticación correcta. Si
  // alguien escribe la URL directamente, vuelve al inicio.
  //
  // Ojo: esto es comodidad de navegación, NO seguridad. La protección
  // real de cualquier dato sensible que se añada aquí deberá validar el
  // token de sesión contra el backend en cada petición.
  if (!state.name) {
    return <Navigate to="/" replace />;
  }

  const firstName = state.name.split(' ')[0];

  const handleExit = () => {
    sessionStorage.removeItem('accessToken');
    navigate('/', { replace: true });
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-surface-100 to-surface-200 px-4 dark:from-surface-950 dark:to-surface-900">
      <Card className="animate-fade-up w-full max-w-md p-8 text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-granted/15">
          <CheckCircle2 className="h-9 w-9 text-granted" />
        </div>

        <h1 className="text-2xl font-bold tracking-tight">
          Bienvenido al sistema
        </h1>
        <p className="mt-2 text-lg text-surface-700 dark:text-surface-300">
          Bienvenido, <span className="font-semibold">{firstName}</span>
        </p>

        <p className="mt-6 text-sm text-surface-600">
          Tu identidad fue verificada correctamente.
        </p>

        <Button
          variant="secondary"
          className="mt-8 w-full"
          onClick={handleExit}
          icon={<LogOut className="h-4 w-4" />}
        >
          Salir
        </Button>
      </Card>
    </div>
  );
}
