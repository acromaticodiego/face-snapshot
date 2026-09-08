import {
  AlertCircle,
  Camera,
  CheckCircle2,
  ScanFace,
  ShieldCheck,
  UserPlus,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { FaceOverlay } from '@/components/camera/FaceOverlay';
import { Badge, Button, Card } from '@/components/ui';
import { useCamera } from '@/hooks/useCamera';
import { useFaceAuth, type AuthPhase } from '@/hooks/useFaceAuth';
import { cn } from '@/lib/utils';

const CAPTURE_FPS = Number(import.meta.env.VITE_CAPTURE_FPS ?? 5);

const PHASE_STYLES: Record<
  AuthPhase,
  { ring: string; tone: 'neutral' | 'granted' | 'denied' | 'pending' }
> = {
  idle: { ring: 'ring-surface-300 dark:ring-surface-700', tone: 'neutral' },
  searching: { ring: 'ring-brand-500/40', tone: 'neutral' },
  detected: { ring: 'ring-pending/60', tone: 'pending' },
  verifying: { ring: 'ring-pending/60', tone: 'pending' },
  granted: { ring: 'ring-granted', tone: 'granted' },
  denied: { ring: 'ring-denied', tone: 'denied' },
  error: { ring: 'ring-denied', tone: 'denied' },
};

export function AuthPage() {
  const navigate = useNavigate();
  const camera = useCamera({ width: 1280, height: 720 });
  const [source, setSource] = useState({ width: 640, height: 480 });

  const handleGranted = useCallback(
    (person: { id: string; name: string }, token?: string) => {
      // La sesión la emite el backend; el frontend solo la transporta.
      if (token) sessionStorage.setItem('accessToken', token);

      // Pausa para que dé tiempo a leer el nombre en la confirmación
      // verde antes de cambiar de pantalla. Con menos, el nombre aparece
      // y desaparece antes de poder leerlo.
      setTimeout(() => {
        navigate('/bienvenida', {
          replace: true,
          state: { name: person.name, id: person.id },
        });
      }, 2000);
    },
    [navigate],
  );

  const auth = useFaceAuth({
    captureFrame: camera.captureFrame,
    enabled: camera.isReady,
    fps: CAPTURE_FPS,
    onGranted: handleGranted,
  });

  useEffect(() => {
    void camera.start();
    // Solo debe arrancar una vez, al montar la pantalla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Las cajas llegan en las coordenadas del frame que analizó el backend.
  useEffect(() => {
    const video = camera.videoRef.current;
    if (video?.videoWidth) {
      const scale = Math.min(1, 640 / video.videoWidth);
      setSource({
        width: Math.round(video.videoWidth * scale),
        height: Math.round(video.videoHeight * scale),
      });
    }
  }, [camera.isReady, camera.videoRef]);

  const style = PHASE_STYLES[auth.phase];
  const showScanLine = auth.phase === 'searching' || auth.phase === 'verifying';

  return (
    <div className="min-h-dvh bg-gradient-to-b from-surface-100 to-surface-200 dark:from-surface-950 dark:to-surface-900">
      <div className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-6 px-4 py-10">
        {/* Encabezado */}
        <header className="animate-fade-up space-y-2 text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-brand-500/10 px-3 py-1 text-xs font-medium text-brand-600 dark:text-brand-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            Control de acceso
          </div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Autenticación facial
          </h1>
          <p className="text-sm text-surface-600">
            Sitúa tu rostro dentro del encuadre y mantente quieto un momento.
          </p>
        </header>

        {/* Visor */}
        <Card
          className={cn(
            'relative w-full overflow-hidden p-0 ring-4 transition-all duration-500',
            style.ring,
          )}
        >
          <div className="relative aspect-video w-full bg-surface-950">
            <video
              ref={camera.videoRef}
              playsInline
              muted
              autoPlay
              className={cn(
                'h-full w-full object-cover transition-opacity duration-700',
                camera.isReady ? 'opacity-100' : 'opacity-0',
                // Espejo: la gente espera verse como en un espejo.
                '-scale-x-100',
              )}
            />

            {camera.isReady && (
              <FaceOverlay
                faces={auth.faces}
                sourceWidth={source.width}
                sourceHeight={source.height}
                videoRef={camera.videoRef}
                mirrored
              />
            )}

            {/* Línea de escaneo */}
            {showScanLine && camera.isReady && (
              <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <div className="animate-scan h-1 w-full bg-gradient-to-r from-transparent via-brand-400 to-transparent shadow-[0_0_18px_var(--color-brand-400)]" />
              </div>
            )}

            {/* Guía de encuadre, mientras no hay rostro */}
            {camera.isReady && auth.faces.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="animate-pulse-ring h-52 w-40 rounded-[50%] border-2 border-dashed border-white/25 sm:h-64 sm:w-52" />
              </div>
            )}

            {/* Estados de la cámara */}
            {!camera.isReady && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                {camera.status === 'requesting' && (
                  <>
                    <Camera className="h-10 w-10 animate-pulse text-surface-300" />
                    <p className="text-sm text-surface-300">
                      Solicitando acceso a la cámara...
                    </p>
                  </>
                )}
                {(camera.status === 'denied' ||
                  camera.status === 'unavailable' ||
                  camera.status === 'error') && (
                  <>
                    <AlertCircle className="h-10 w-10 text-denied" />
                    <p className="max-w-sm text-sm text-surface-300">
                      {camera.error}
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void camera.start()}
                    >
                      Reintentar
                    </Button>
                  </>
                )}
              </div>
            )}

            {/* Velo de éxito */}
            {auth.phase === 'granted' && (
              <div className="animate-fade-up absolute inset-0 flex flex-col items-center justify-center gap-2 bg-granted/25 px-6 text-center backdrop-blur-sm">
                <CheckCircle2 className="h-14 w-14 text-white drop-shadow-lg" />

                {/* El nombre es lo más importante de esta pantalla: es la
                    confirmación de que el sistema reconoció a la persona
                    correcta, y quien está delante debe poder leerlo. */}
                {auth.person && (
                  <p className="text-3xl font-bold tracking-tight text-white drop-shadow-lg sm:text-4xl">
                    {auth.person.name}
                  </p>
                )}

                <p className="text-base font-medium text-white/90 drop-shadow">
                  Acceso concedido
                </p>
              </div>
            )}
          </div>

          {/* Barra de estado */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-200 px-4 py-3 dark:border-surface-800">
            <div className="flex items-center gap-2.5">
              <StatusIcon phase={auth.phase} />
              <span
                className="text-sm font-medium"
                role="status"
                aria-live="polite"
              >
                {auth.error ??
                  (auth.phase === 'granted' && auth.person
                    ? `Identidad confirmada: ${auth.person.name}`
                    : auth.message)}
              </span>
            </div>

            {auth.votes.required > 0 && auth.phase === 'verifying' && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-surface-600">
                  {auth.votes.current} de {auth.votes.required}
                </span>
                <div className="flex gap-1">
                  {Array.from({ length: auth.votes.required }).map((_, i) => (
                    <span
                      key={i}
                      className={cn(
                        'h-1.5 w-5 rounded-full transition-colors duration-300',
                        i < auth.votes.current
                          ? 'bg-granted'
                          : 'bg-surface-300 dark:bg-surface-700',
                      )}
                    />
                  ))}
                </div>
              </div>
            )}

            {auth.phase === 'denied' && (
              <Badge tone="denied">Rostro no registrado</Badge>
            )}
          </div>
        </Card>

        {/* Acciones */}
        <div className="flex items-center gap-3">
          {auth.phase === 'error' && (
            <Button variant="secondary" onClick={auth.reset}>
              Reintentar
            </Button>
          )}
          {/* Segunda via de entrada al sistema: quien va a dar de alta a
              alguien nuevo pasa por aquí. Lleva a /admin/faces y no
              directamente al login para que, si ya hay sesión abierta, no
              vuelva a pedir credenciales. */}
          <Link to="/admin/faces">
            <Button
              variant="secondary"
              icon={<UserPlus className="h-4 w-4" />}
            >
              Registrar nueva persona
            </Button>
          </Link>
        </div>

        <p className="max-w-md text-center text-xs text-surface-600">
          La verificación se realiza en el servidor. No se almacenan imágenes de
          tu rostro.
        </p>
      </div>
    </div>
  );
}

function StatusIcon({ phase }: { phase: AuthPhase }) {
  if (phase === 'granted')
    return <CheckCircle2 className="h-5 w-5 shrink-0 text-granted" />;
  if (phase === 'denied' || phase === 'error')
    return <XCircle className="h-5 w-5 shrink-0 text-denied" />;
  if (phase === 'verifying' || phase === 'detected')
    return <ScanFace className="h-5 w-5 shrink-0 animate-pulse text-pending" />;
  return <ScanFace className="h-5 w-5 shrink-0 animate-pulse text-brand-500" />;
}
