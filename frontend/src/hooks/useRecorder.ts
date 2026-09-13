import { useCallback, useEffect, useRef, useState } from 'react';

export type RecorderStatus =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'unavailable'
  | 'denied'
  | 'error';

/**
 * Graba audio del micrófono.
 *
 * Mismo reparto que `useCamera`: este hook gestiona el ciclo de vida
 * del dispositivo y traduce los errores a algo accionable, y quien lo
 * usa decide qué hacer con lo grabado. Aquí no se envía nada a ningún
 * sitio.
 *
 * EL AUDIO NO SE GUARDA
 * ─────────────────────
 * Vive como `Blob` en memoria mientras dura la revisión del borrador y
 * se suelta al salir. No se escribe en disco, ni en `localStorage`, ni
 * en ninguna caché. Es la misma política que el backend aplica al
 * audio y a las imágenes faciales: lo que no se almacena no se puede
 * filtrar.
 */
export function useRecorder() {
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

  /** Suelta el micrófono. El piloto del dispositivo se apaga aquí. */
  const release = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus('unavailable');
      setError(
        'Este navegador no permite grabar audio. Requiere HTTPS o localhost.',
      );
      return false;
    }

    setStatus('requesting');
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Sin forzar `mimeType`: cada navegador soporta contenedores
      // distintos y el que elija por defecto es el que sabe producir
      // bien. El Gateway acepta los habituales y comprueba la cabecera
      // del archivo, así que no hace falta imponer uno desde aquí.
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.start();
      recorderRef.current = recorder;
      setSeconds(0);
      setStatus('recording');
      return true;
    } catch (err) {
      const name = (err as DOMException)?.name;
      release();

      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('denied');
        setError(
          'Permiso de micrófono denegado. Actívalo en el icono de la barra de direcciones y recarga.',
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setStatus('unavailable');
        setError('No se detectó ningún micrófono conectado.');
      } else if (name === 'NotReadableError') {
        setStatus('error');
        setError('El micrófono lo está usando otra aplicación. Ciérrala e inténtalo de nuevo.');
      } else {
        setStatus('error');
        setError('No se pudo iniciar la grabación.');
      }
      return false;
    }
  }, [release]);

  /**
   * Detiene y devuelve lo grabado.
   *
   * El `Blob` se construye en el evento `stop` y no antes: los trozos
   * llegan de forma asíncrona, y cerrarlo al pulsar el botón perdería
   * el último fragmento, que suele ser justo el final de la frase.
   */
  const stop = useCallback(async (): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      setStatus('idle');
      return null;
    }

    const audio = await new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        const trozos = chunksRef.current;
        chunksRef.current = [];
        resolve(
          trozos.length > 0
            ? new Blob(trozos, { type: recorder.mimeType || 'audio/webm' })
            : null,
        );
      };
      recorder.stop();
    });

    release();
    setStatus('idle');
    return audio;
  }, [release]);

  /** Cuenta los segundos grabados, para que se vea que está pasando algo. */
  useEffect(() => {
    if (status !== 'recording') return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  // Al desmontar se suelta el micrófono: si no, el piloto sigue
  // encendido aunque se haya cambiado de página.
  useEffect(() => release, [release]);

  return {
    status,
    error,
    seconds,
    isRecording: status === 'recording',
    start,
    stop,
  };
}
