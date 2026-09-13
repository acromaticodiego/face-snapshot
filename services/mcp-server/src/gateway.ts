/**
 * Cliente del API Gateway.
 *
 * ESTE SERVIDOR NO HABLA CON LA BASE DE DATOS NI CON LOS SERVICIOS
 * INTERNOS. SOLO CON EL GATEWAY.
 * ────────────────────────────────────────────────────────────────
 * Podría ser más rápido consultando PostgreSQL directamente, y sería
 * un error. El Gateway es el único punto de entrada del sistema: ahí
 * viven los guards, el rate limiting y la normalización de errores.
 * Un segundo camino hacia los datos sería una segunda puerta que nadie
 * vigila, y además se saltaría el aislamiento por roles de PostgreSQL
 * que el proyecto se ha tomado el trabajo de montar.
 *
 * Dicho de otro modo: este servidor MCP es un cliente más, como el
 * navegador. No tiene privilegios que no tenga un administrador
 * sentado delante del panel.
 *
 * TODO LO QUE HACE ES LEER
 * ───────────────────────
 * No hay aquí un solo método que escriba. Ninguna herramienta abre una
 * puerta, firma un parte ni modifica una jornada. Un modelo de
 * lenguaje conectado a esto puede contarte lo que pasó; no puede
 * hacer que pase nada.
 */

export interface GatewayOptions {
  baseUrl: string;
  email: string;
  password: string;
  timeoutMs: number;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export class GatewayClient {
  private token: string | null = null;

  constructor(private readonly options: GatewayOptions) {}

  /**
   * Una lectura, reintentando UNA vez si el token había caducado.
   *
   * El token de administración dura horas y este proceso vive días:
   * que caduque a mitad de una conversación es lo normal, no la
   * excepción. Reintentar una vez tras volver a autenticarse convierte
   * un fallo seguro en algo que el usuario ni nota.
   *
   * Solo se reintenta ante un 401. Un 403 o un 404 darían lo mismo las
   * veces que se pidieran.
   */
  async get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    if (!this.token) await this.login();

    try {
      return await this.request<T>(path, params);
    } catch (error) {
      if (error instanceof GatewayError && error.status === 401) {
        this.token = null;
        await this.login();
        return this.request<T>(path, params);
      }
      throw error;
    }
  }

  private async login(): Promise<void> {
    const respuesta = await this.fetchWithTimeout(
      new URL('/api/v1/admin/auth/login', this.options.baseUrl),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: this.options.email,
          password: this.options.password,
        }),
      },
    );

    if (!respuesta.ok) {
      // El mensaje del Auth Service es deliberadamente genérico para no
      // delatar si una cuenta existe, y aquí se respeta: no se añade
      // nada que lo haga más específico.
      throw new GatewayError(
        `No se pudo iniciar sesión en el Gateway (HTTP ${respuesta.status}). ` +
          'Revisa DETECTOR_ADMIN_EMAIL y DETECTOR_ADMIN_PASSWORD.',
        respuesta.status,
      );
    }

    const datos = (await respuesta.json()) as { accessToken?: string; token?: string };
    const token = datos.accessToken ?? datos.token;
    if (!token) {
      throw new GatewayError('El Gateway no devolvió ningún token de administración');
    }
    this.token = token;
  }

  private async request<T>(
    path: string,
    params: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(`/api/v1${path}`, this.options.baseUrl);
    for (const [clave, valor] of Object.entries(params)) {
      if (valor !== undefined && valor !== '') url.searchParams.set(clave, valor);
    }

    const respuesta = await this.fetchWithTimeout(url, {
      headers: { authorization: `Bearer ${this.token}` },
    });

    if (!respuesta.ok) {
      throw new GatewayError(
        `El Gateway respondió ${respuesta.status} a ${path}`,
        respuesta.status,
      );
    }

    return (await respuesta.json()) as T;
  }

  /**
   * `fetch` con plazo.
   *
   * Sin él, un Gateway que acepta la conexión y no responde dejaría la
   * herramienta colgada para siempre, y quien la llamó no tiene forma
   * de cancelarla.
   */
  private async fetchWithTimeout(url: URL, init: RequestInit = {}): Promise<Response> {
    const corte = AbortSignal.timeout(this.options.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: corte });
    } catch (error) {
      if (corte.aborted) {
        throw new GatewayError(
          `El Gateway no respondió en ${this.options.timeoutMs} ms. ` +
            '¿Está levantado el stack? (docker compose up -d)',
        );
      }
      throw new GatewayError(
        `No se pudo contactar con el Gateway en ${this.options.baseUrl}: ` +
          (error as Error).message,
      );
    }
  }
}
