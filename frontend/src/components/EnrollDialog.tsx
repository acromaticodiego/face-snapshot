import { AlertCircle, Camera, CheckCircle2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { GlassCard, VaultButton } from '@/components/vault';
import { useCamera } from '@/hooks/useCamera';
import { api, ApiError, type Person } from '@/lib/api';

interface EnrollDialogProps {
  person: Person;
  onClose: () => void;
  onEnrolled: () => void;
}

type Step = 'camera' | 'submitting' | 'done';

/**
 * Captura del rostro de una persona.
 *
 * La imagen se envía al backend y NO se guarda: el servidor extrae el
 * vector facial y descarta la fotografía. El operador ve una vista previa
 * local para poder repetir la toma si no le convence, pero esa imagen
 * nunca sale del navegador salvo en el envío de registro.
 */
export function EnrollDialog({
  person,
  onClose,
  onEnrolled,
}: EnrollDialogProps) {
  const camera = useCamera({ width: 1280, height: 720 });
  const [step, setStep] = useState<Step>('camera');
  const [preview, setPreview] = useState<string | null>(null);
  const [captured, setCaptured] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void camera.start();
    return () => camera.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cerrar con Escape: comportamiento esperado en cualquier diálogo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Libera la URL del objeto para no filtrar memoria al repetir tomas.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const handleCapture = async () => {
    setError(null);
    // Para enrolar se usa más resolución que en la autenticación: es una
    // sola imagen y su calidad condiciona todos los reconocimientos
    // futuros de esta persona.
    const blob = await camera.captureFrame(960, 0.9);
    if (!blob) {
      setError('No se pudo capturar la imagen');
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setCaptured(blob);
    setPreview(URL.createObjectURL(blob));
  };

  const handleSubmit = async () => {
    if (!captured) return;
    setStep('submitting');
    setError(null);

    try {
      const result = await api.enrollFace(person.id, captured);
      setStep('done');
      toast.success(
        `Rostro registrado (calidad ${Math.round(result.detectionScore * 100)}%)`,
      );
      setTimeout(onEnrolled, 900);
    } catch (err) {
      setStep('camera');
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo registrar el rostro',
      );
    }
  };

  const retake = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setCaptured(null);
    setError(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="enroll-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <GlassCard className="animate-fade-up w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 id="enroll-title" className="font-semibold text-white">
              Capturar rostro
            </h2>
            <p className="text-xs text-white/45">{person.fullName}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-lg p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative aspect-video bg-black">
          {preview ? (
            <img
              src={preview}
              alt="Captura para revisar"
              className="h-full w-full -scale-x-100 object-cover"
            />
          ) : (
            <>
              <video
                ref={camera.videoRef}
                playsInline
                muted
                autoPlay
                className="h-full w-full -scale-x-100 object-cover"
              />
              {camera.isReady && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="h-56 w-44 rounded-[50%] border-2 border-dashed border-white/30" />
                </div>
              )}
            </>
          )}

          {!camera.isReady && !preview && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <Camera className="h-9 w-9 animate-pulse text-white/50" />
              <p className="text-sm text-white/60">
                {camera.error ?? 'Iniciando cámara...'}
              </p>
            </div>
          )}

          {step === 'done' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-vault-green/25 backdrop-blur-sm">
              <CheckCircle2 className="h-14 w-14 text-white" />
              <p className="font-semibold text-white">Rostro registrado</p>
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 border-t border-denied/20 bg-denied/10 px-5 py-3 text-sm text-denied">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-4">
          <p className="text-xs text-white/40">
            Mira de frente, con buena luz y sin gafas de sol.
          </p>
          <div className="flex gap-2">
            {preview ? (
              <>
                <VaultButton size="sm" tone="ghost" onClick={retake}>
                  Repetir
                </VaultButton>
                <VaultButton
                  size="sm"
                  loading={step === 'submitting'}
                  onClick={() => void handleSubmit()}
                >
                  Registrar
                </VaultButton>
              </>
            ) : (
              <VaultButton
                size="sm"
                disabled={!camera.isReady}
                onClick={() => void handleCapture()}
                icon={<Camera className="h-4 w-4" />}
              >
                Capturar
              </VaultButton>
            )}
          </div>
        </div>
      </GlassCard>
    </div>
  );
}
