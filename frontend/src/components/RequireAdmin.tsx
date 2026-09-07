import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { Skeleton } from '@/components/ui';
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
    return (
      <div className="min-h-dvh bg-surface-100 p-8 dark:bg-surface-950">
        <div className="mx-auto max-w-4xl space-y-4">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-20 w-full" />
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
