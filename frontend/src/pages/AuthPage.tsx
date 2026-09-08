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
import {
  GlassCard,
  VaultBackground,
  VaultButton,
  VaultPill,
  VaultTitle,
} from '@/components/vault';
import { useCamera } from '@/hooks/useCamera';
import { useFaceAuth, type AuthPhase } from '@/hooks/useFaceAuth';
import { cn } from '@/lib/utils';

const CAPTURE_FPS = Number(import.meta.env.VITE_CAPTURE_FPS ?? 5);

/**
 * Halo del marco según el estado.
 *
 * Es la señal periférica del veredicto: quien está frente a la cámara
 * percibe el cambio de color del marco completo sin tener que leer el
 * texto de la barra inferior.
 */
const PHASE_GLOW: Record<AuthPhase, string> = {
  idle: 'shadow-[0_0_0_1px_rgb(255_255_255/0.08)]',
  searching:
    'shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_0_60px_-20px_var(--color-vault-purple)]',
  detected:
    'shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_0_60px_-16px_var(--color-vault-orange)]',
  verifying:
    'shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_0_60px_-16px_var(--color-vault-orange)]',
  granted:
    'shadow-[0_0_0_1px_var(--color-vault-green),0_0_70px_-14px_var(--color-vault-green)]',
  denied:
    'shadow-[0_0_0_1px_var(--color-denied),0_0_70px_-16px_var(--color-denied)]',
  error:
    'shadow-[0_0_0_1px_var(--color-denied),0_0_70px_-16px_var(--color-denied)]',
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
      // verde antes de cambiar de pantalla.
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

  const showScanLine = auth.phase === 'searching' || auth.phase === 'verifying';

  return (
    <div className="relative min-h-dvh bg-vault-bg">
      <VaultBackground />

      <div className="relative z-10 mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-6 px-4 py-12">
        {/* ── Encabezado ───────────────────────────────────────── */}
        <header className="animate-fade-up flex flex-col items-center gap-3 text-center">
          <VaultPill
            accent="purple"
            icon={<ShieldCheck className="h-3.5 w-3.5" />}
          >
            Control de acceso
          </VaultPill>

          <VaultTitle className="sm:text-4xl">Autenticación facial</VaultTitle>

          <p className="text-sm text-white/45">
            Sitúa tu rostro dentro del encuadre y mantente quieto un momento.
          </p>
        </header>

        {/* ── Visor ────────────────────────────────────────────── */}
        <GlassCard
          className={cn(
            'w-full overflow-hidden transition-shadow duration-500',
            PHASE_GLOW[auth.phase],
          )}
        >
          <div className="relative aspect-video w-full bg-black">
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
                <div className="animate-scan h-px w-full bg-gradient-to-r from-transparent via-vault-purple to-transparent shadow-[0_0_18px_2px_var(--color-vault-purple)]" />
              </div>
            )}

            {/* Guía de encuadre, mientras no hay rostro */}
            {camera.isReady && auth.faces.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="animate-pulse-ring h-52 w-40 rounded-[50%] border border-dashed border-white/25 sm:h-64 sm:w-52" />
              </div>
            )}

            {/* Estados de la cámara */}
            {!camera.isReady && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                {camera.status === 'requesting' && (
                  <>
                    <Camera className="h-10 w-10 animate-pulse text-white/50" />
                    <p className="text-sm text-white/60">
                      Solicitando acceso a la cámara...
                    </p>
                  </>
                )}
                {(camera.status === 'denied' ||
                  camera.status === 'unavailable' ||
                  camera.status === 'error') && (
                  <>
                    <AlertCircle className="h-10 w-10 text-denied" />
                    <p className="max-w-sm text-sm text-white/60">
                      {camera.error}
                    </p>
                    <VaultButton
                      size="sm"
                      tone="glass"
                      onClick={() => void camera.start()}
                    >
                      Reintentar
                    </VaultButton>
                  </>
                )}
              </div>
            )}

            {/* Velo de éxito */}
            {auth.phase === 'granted' && (
              <div className="animate-fade-up absolute inset-0 flex flex-col items-center justify-center gap-2 bg-vault-green/20 px-6 text-center backdrop-blur-sm">
                <CheckCircle2 className="h-14 w-14 text-white drop-shadow-[0_0_16px_var(--color-vault-green)]" />

                {/* El nombre es lo más importante de esta pantalla: es la
                    confirmación de que el sistema reconoció a la persona
                    correcta, y quien está delante debe poder leerlo. */}
                {auth.person && (
                  <p className="text-3xl font-bold tracking-tight text-white drop-shadow-lg sm:text-4xl">
                    {auth.person.name}
                  </p>
                )}

                <p className="text-base font-medium text-white/90">
                  Acceso concedido
                </p>
              </div>
            )}

            {/* ── Barra de estado, dentro del visor ────────────── */}
            <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-black/45 px-4 py-3 backdrop-blur-xl">
              <div className="flex items-center gap-2.5">
                <StatusIcon phase={auth.phase} />
                <span
                  className="text-sm font-medium text-white"
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
                  <span className="text-xs text-white/50">
                    {auth.votes.current} de {auth.votes.required}
                  </span>
                  <div className="flex gap-1">
                    {Array.from({ length: auth.votes.required }).map((_, i) => (
                      <span
                        key={i}
                        className={cn(
                          'h-1.5 w-5 rounded-full transition-all duration-300',
                          i < auth.votes.current
                            ? 'bg-vault-green shadow-[0_0_10px_var(--color-vault-green)]'
                            : 'bg-white/20',
                        )}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </GlassCard>

        {/* ── Acciones ─────────────────────────────────────────── */}
        <div className="flex items-center gap-3">
          {auth.phase === 'error' && (
            <VaultButton tone="glass" onClick={auth.reset}>
              Reintentar
            </VaultButton>
          )}

          {/* Segunda vía de entrada: quien va a dar de alta a alguien
              pasa por aquí. Lleva a /admin/faces y no directamente al
              login para que, si ya hay sesión abierta, no vuelva a pedir
              credenciales. */}
          <Link to="/admin/faces">
            <VaultButton tone="glass" icon={<UserPlus className="h-4 w-4" />}>
              Registrar nueva persona
            </VaultButton>
          </Link>
        </div>

        <p className="max-w-md text-center text-xs text-white/35">
          La verificación se realiza en el servidor. No se almacenan imágenes de
          tu rostro.
        </p>
      </div>
    </div>
  );
}

function StatusIcon({ phase }: { phase: AuthPhase }) {
  if (phase === 'granted')
    return (
      <CheckCircle2 className="h-5 w-5 shrink-0 text-vault-green drop-shadow-[0_0_8px_var(--color-vault-green)]" />
    );
  if (phase === 'denied' || phase === 'error')
    return (
      <XCircle className="h-5 w-5 shrink-0 text-denied drop-shadow-[0_0_8px_var(--color-denied)]" />
    );
  if (phase === 'verifying' || phase === 'detected')
    return (
      <ScanFace className="h-5 w-5 shrink-0 animate-pulse text-vault-orange" />
    );
  return (
    <ScanFace className="h-5 w-5 shrink-0 animate-pulse text-vault-purple" />
  );
}
