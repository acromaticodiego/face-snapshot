import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'ready'
  | 'denied'
  | 'unavailable'
  | 'error';

interface UseCameraOptions {
  width?: number;
  height?: number;
  facingMode?: 'user' | 'environment';
}

/**
 * Gestiona el ciclo de vida de la cámara.
 *
 * Traduce los errores de `getUserMedia` a mensajes accionables: "permiso
 * denegado" y "no hay cámara" requieren acciones distintas del usuario, y
 * un mensaje genérico no ayudaría a resolver ninguno de los dos.
 */
export function useCamera(options: UseCameraOptions = {}) {
  const { width = 1280, height = 720, facingMode = 'user' } = options;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus('idle');
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unavailable');
      setError(
        'Este navegador no permite el acceso a la cámara. Requiere HTTPS o localhost.',
      );
      return;
    }

    setStatus('requesting');
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: width },
          height: { ideal: height },
          facingMode,
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStatus('ready');
    } catch (err) {
      const name = (err as DOMException)?.name;

      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('denied');
        setError(
          'Permiso de cámara denegado. Actívalo en el icono de la barra de direcciones y recarga.',
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setStatus('unavailable');
        setError('No se detectó ninguna cámara conectada.');
      } else if (name === 'NotReadableError') {
        setStatus('error');
        setError(
          'La cámara está siendo usada por otra aplicación. Ciérrala e inténtalo de nuevo.',
        );
      } else {
        setStatus('error');
        setError('No se pudo iniciar la cámara.');
      }
    }
  }, [width, height, facingMode]);

  /**
   * Captura el fotograma actual como JPEG.
   *
   * Se reescala a `maxWidth` antes de enviarlo: un frame de 1280px pesa
   * unas seis veces más que uno de 640 y no mejora la detección, porque
   * el detector reescala igualmente a 640 internamente.
   */
  const captureFrame = useCallback(
    async (maxWidth = 640, quality = 0.75): Promise<Blob | null> => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return null;

      const scale = Math.min(1, maxWidth / video.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);

      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      return new Promise((resolve) =>
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality),
      );
    },
    [],
  );

  // La cámara se libera al desmontar: si no, el piloto del dispositivo
  // sigue encendido aunque el usuario haya cambiado de página.
  useEffect(() => stop, [stop]);

  return {
    videoRef,
    status,
    error,
    start,
    stop,
    captureFrame,
    isReady: status === 'ready',
  };
}
