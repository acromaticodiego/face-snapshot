/**
 * Sesión de administrador en el navegador.
 *
 * DÓNDE SE GUARDA EL TOKEN Y POR QUÉ
 * ----------------------------------
 * En `sessionStorage`, no en `localStorage`: la sesión muere al cerrar
 * la pestaña, que es el comportamiento razonable en un panel de
 * administración que puede quedarse abierto en un equipo compartido.
 *
 * Lo ideal en producción sería una cookie `httpOnly`, inaccesible desde
 * JavaScript y por tanto inmune al robo por XSS. No se hizo así porque
 * exige que el Gateway y el frontend compartan dominio (o CSRF tokens
 * para las peticiones entre orígenes), y eso condiciona el despliegue.
 * Queda anotado como mejora en el README.
 */

const TOKEN_KEY = 'adminToken';
const ADMIN_KEY = 'adminProfile';

export interface AdminProfile {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

type Listener = (admin: AdminProfile | null) => void;
const listeners = new Set<Listener>();

function notify(admin: AdminProfile | null): void {
  listeners.forEach((fn) => fn(admin));
}

export const adminSession = {
  getToken(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      // Modo privado o almacenamiento bloqueado por el navegador.
      return null;
    }
  },

  getProfile(): AdminProfile | null {
    try {
      const raw = sessionStorage.getItem(ADMIN_KEY);
      return raw ? (JSON.parse(raw) as AdminProfile) : null;
    } catch {
      return null;
    }
  },

  save(token: string, admin: AdminProfile): void {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(ADMIN_KEY, JSON.stringify(admin));
    } catch {
      // Si no se puede persistir, la sesión dura lo que dure la página.
    }
    notify(admin);
  },

  clear(): void {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(ADMIN_KEY);
    } catch {
      /* nada que limpiar */
    }
    notify(null);
  },

  /** Permite que la interfaz reaccione al cierre de sesión. */
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
