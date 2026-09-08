import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { VaultBackground } from '@/components/vault';
import { api } from '@/lib/api';
import { adminSession } from '@/lib/auth';

/**
 * Protege las rutas de administración en el cliente.
 *
 * IMPORTANTE: esto es comodidad de navegación, NO seguridad. Quien
 * manipule el JavaScript del navegador puede saltárselo y ver el
 * armazón de la pantalla, pero no obtendrá ni un solo dato: el Gateway
 * rechaza toda petición a /admin sin un token válido.
 *
 * La seguridad real vive en el backend; esto solo evita enseñar una
 * pantalla vacía y llena de errores a quien no ha iniciado sesión.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [state, setState] = useState<'checking' | 'ok' | 'denied'>(
    adminSession.getToken() ? 'checking' : 'denied',
  );

  useEffect(() => {
    if (!adminSession.getToken()) {
      setState('denied');
      return;
    }

    // Se valida el token contra el backend en lugar de confiar en su
    // mera presencia: pudo caducar mientras la pestaña estaba abierta.
    let cancelled = false;
    api
      .adminMe()
      .then(() => !cancelled && setState('ok'))
      .catch(() => {
        if (cancelled) return;
        adminSession.clear();
        setState('denied');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'checking') {
    // Mismo fondo que el panel: sin esto se vería un destello claro
    // entre la comprobación del token y la pantalla real.
    return (
      <div className="relative min-h-dvh bg-vault-bg p-8">
        <VaultBackground />
        <div className="relative z-10 mx-auto max-w-4xl space-y-4">
          <div className="h-8 w-56 animate-pulse rounded-lg bg-white/10" />
          <div className="h-32 w-full animate-pulse rounded-2xl bg-white/[0.06]" />
          <div className="h-20 w-full animate-pulse rounded-2xl bg-white/[0.06]" />
        </div>
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <Navigate
        to="/admin/login"
        replace
        state={{ from: location.pathname }}
      />
    );
  }

  return <>{children}</>;
}
