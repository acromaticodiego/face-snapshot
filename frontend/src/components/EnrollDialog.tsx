import { AlertCircle, Camera, CheckCircle2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui';
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="enroll-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="animate-fade-up w-full max-w-lg overflow-hidden rounded-card bg-white shadow-2xl dark:bg-surface-900">
        <div className="flex items-center justify-between border-b border-surface-200 px-5 py-4 dark:border-surface-800">
          <div>
            <h2 id="enroll-title" className="font-semibold">
              Capturar rostro
            </h2>
            <p className="text-xs text-surface-600">{person.fullName}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-lg p-1.5 text-surface-600 transition-colors hover:bg-surface-200 dark:hover:bg-surface-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative aspect-video bg-surface-950">
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
              <Camera className="h-9 w-9 animate-pulse text-surface-300" />
              <p className="text-sm text-surface-300">
                {camera.error ?? 'Iniciando cámara...'}
              </p>
            </div>
          )}

          {step === 'done' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-granted/25 backdrop-blur-sm">
              <CheckCircle2 className="h-14 w-14 text-white" />
              <p className="font-semibold text-white">Rostro registrado</p>
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 border-t border-denied/20 bg-denied/10 px-5 py-3 text-sm text-denied-dim dark:text-denied">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-surface-200 px-5 py-4 dark:border-surface-800">
          <p className="text-xs text-surface-600">
            Mira de frente, con buena luz y sin gafas de sol.
          </p>
          <div className="flex gap-2">
            {preview ? (
              <>
                <Button variant="secondary" size="sm" onClick={retake}>
                  Repetir
                </Button>
                <Button
                  size="sm"
                  loading={step === 'submitting'}
                  onClick={() => void handleSubmit()}
                >
                  Registrar
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={!camera.isReady}
                onClick={() => void handleCapture()}
                icon={<Camera className="h-4 w-4" />}
              >
                Capturar
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
