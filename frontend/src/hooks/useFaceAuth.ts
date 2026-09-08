import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError } from '@/lib/api';
import type { AccessReason, FaceVerdict, VerifyFrameResponse } from '@/lib/api';

export type AuthPhase =
  | 'idle'
  | 'searching'
  | 'detected'
  | 'verifying'
  | 'granted'
  | 'denied'
  | 'error';

interface UseFaceAuthOptions {
  captureFrame: () => Promise<Blob | null>;
  enabled: boolean;
  fps?: number;
  onGranted?: (person: { id: string; name: string }, token?: string) => void;
}

const MESSAGES: Record<AccessReason, string> = {
  GRANTED: 'Identidad confirmada',
  BELOW_THRESHOLD: 'Rostro no registrado',
  NO_FACE_DETECTED: 'Buscando rostro...',
  MULTIPLE_FACES: 'Se detectó más de una persona',
  LOW_QUALITY: 'Acércate y mejora la iluminación',
  INSUFFICIENT_VOTES: 'Verificando identidad...',
  PERSON_SUSPENDED: 'Acceso suspendido',
};

/**
 * Bucle de autenticación facial.
 *
 * Envía frames al backend y expone el veredicto para pintarlo. NO decide
 * nada: `authenticated` llega decidido desde el Access Service.
 *
 * El bucle es secuencial, no un `setInterval`: cada petición espera a la
 * anterior. Con intervalos fijos, si el backend tarda más que el
 * intervalo, las peticiones se encolarían indefinidamente hasta saturar
 * al servidor y desincronizar las cajas del vídeo.
 */
export function useFaceAuth({
  captureFrame,
  enabled,
  fps = 5,
  onGranted,
}: UseFaceAuthOptions) {
  const [phase, setPhase] = useState<AuthPhase>('idle');
  const [faces, setFaces] = useState<FaceVerdict[]>([]);
  const [message, setMessage] = useState('Iniciando cámara...');
  const [votes, setVotes] = useState({ current: 0, required: 0 });
  const [error, setError] = useState<string | null>(null);
  /**
   * Persona reconocida, disponible en cuanto se concede el acceso.
   *
   * Se guarda aparte de `faces` porque las cajas se vacían en cuanto
   * deja de haber detecciones, y el nombre debe seguir en pantalla
   * durante la confirmación en verde, justo antes de cambiar de vista.
   */
  const [person, setPerson] = useState<{ id: string; name: string } | null>(
    null,
  );

  const sessionKeyRef = useRef<string | undefined>(undefined);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const consecutiveErrorsRef = useRef(0);
  const onGrantedRef = useRef(onGranted);

  useEffect(() => {
    onGrantedRef.current = onGranted;
  }, [onGranted]);

  const applyResult = useCallback((result: VerifyFrameResponse) => {
    setFaces(result.faces);
    setVotes(result.votes);
    sessionKeyRef.current = result.sessionKey;
    consecutiveErrorsRef.current = 0;

    if (result.authenticated && result.person) {
      setPerson(result.person);
      setPhase('granted');
      setMessage(`Bienvenido, ${result.person.name.split(' ')[0]}`);
      onGrantedRef.current?.(result.person, result.accessToken);
      return true;
    }

    if (result.faces.length === 0) {
      setPhase('searching');
    } else if (result.reason === 'INSUFFICIENT_VOTES') {
      setPhase('verifying');
    } else if (result.reason === 'BELOW_THRESHOLD') {
      setPhase('denied');
    } else {
      setPhase('detected');
    }

    setMessage(MESSAGES[result.reason]);
    return false;
  }, []);

  useEffect(() => {
    if (!enabled) {
      runningRef.current = false;
      abortRef.current?.abort();
      return;
    }

    runningRef.current = true;
    const intervalMs = 1000 / fps;
    setPhase('searching');
    setMessage('Buscando rostro...');

    const loop = async () => {
      while (runningRef.current) {
        const startedAt = performance.now();

        try {
          const frame = await captureFrame();
          if (frame) {
            abortRef.current = new AbortController();
            const result = await api.verifyFrame(
              frame,
              sessionKeyRef.current,
              abortRef.current.signal,
            );

            if (!runningRef.current) break;
            if (applyResult(result)) {
              runningRef.current = false;
              break;
            }
          }
        } catch (err) {
          if ((err as Error).name === 'AbortError') break;

          consecutiveErrorsRef.current += 1;

          // Un fallo puntual de red no debe romper la sesión; tres
          // seguidos sí indican que el backend no está disponible.
          if (consecutiveErrorsRef.current >= 3) {
            setPhase('error');
            setError(
              err instanceof ApiError
                ? err.message
                : 'Se perdió la conexión con el servidor',
            );
            runningRef.current = false;
            break;
          }
        }

        // Descuenta lo que ya tardó la petición para mantener el ritmo.
        const elapsed = performance.now() - startedAt;
        const wait = Math.max(0, intervalMs - elapsed);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    };

    void loop();

    return () => {
      runningRef.current = false;
      abortRef.current?.abort();
    };
  }, [enabled, fps, captureFrame, applyResult]);

  const reset = useCallback(() => {
    sessionKeyRef.current = undefined;
    consecutiveErrorsRef.current = 0;
    setFaces([]);
    setPerson(null);
    setVotes({ current: 0, required: 0 });
    setError(null);
    setPhase('searching');
    setMessage('Buscando rostro...');
  }, []);

  return { phase, faces, person, message, votes, error, reset };
}
