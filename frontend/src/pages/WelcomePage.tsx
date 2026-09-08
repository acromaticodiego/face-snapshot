import { CheckCircle2, LogOut } from 'lucide-react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import {
  GlassCard,
  VaultBackground,
  VaultButton,
  VaultTitle,
} from '@/components/vault';

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

  const handleExit = () => {
    sessionStorage.removeItem('accessToken');
    navigate('/', { replace: true });
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-vault-bg px-4">
      <VaultBackground />

      <GlassCard
        glow="green"
        className="animate-fade-up relative z-10 w-full max-w-md p-8 text-center"
      >
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-vault-green/40 bg-vault-green/10 shadow-[0_0_30px_-8px_var(--color-vault-green)]">
          <CheckCircle2 className="h-9 w-9 text-vault-green" />
        </div>

        <p className="text-xs font-medium tracking-widest text-white/40 uppercase">
          Bienvenido al sistema
        </p>

        {/* El nombre completo, y no solo el primero: es la confirmación
            de a quién identificó el sistema, así que debe poder
            comprobarse de un vistazo. */}
        <VaultTitle className="mt-2 text-balance">{state.name}</VaultTitle>

        <p className="mt-4 text-sm text-white/45">
          Tu identidad fue verificada correctamente.
        </p>

        <VaultButton
          tone="glass"
          className="mt-8 w-full"
          onClick={handleExit}
          icon={<LogOut className="h-4 w-4" />}
        >
          Salir
        </VaultButton>
      </GlassCard>
    </div>
  );
}
