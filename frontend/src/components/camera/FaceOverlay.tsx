import { useEffect, useRef, useState } from 'react';

import type { FaceVerdict } from '@/lib/api';

interface FaceOverlayProps {
  faces: FaceVerdict[];
  /** Dimensiones del frame analizado por el backend. */
  sourceWidth: number;
  sourceHeight: number;
  /** Elemento de vídeo sobre el que se dibuja. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mirrored?: boolean;
  /**
   * La captura no parece una persona viva.
   *
   * Cuando esto es cierto manda sobre todo lo demas, incluso si el
   * rostro se reconocio: una foto de alguien registrado SE RECONOCE
   * -al 76 % en la prueba del 2026-09-14- y justo por eso pintarla de
   * verde seria decir lo contrario de lo que pasa.
   */
  suspicious?: boolean;
}

/**
 * Dibuja las cajas sobre el vídeo.
 *
 * VERDE    = persona registrada.
 * ROJA     = rostro desconocido.
 * NARANJA  = la captura no parece una persona viva.
 *
 * El naranja NO es un rojo mas suave: es una categoria distinta. Rojo
 * significa «no te conozco»; naranja significa «esto puede ser una
 * foto». Para quien opera el sistema son dos incidentes de gravedad
 * muy distinta, y si compartieran color no podria distinguirlos de un
 * vistazo, que es justo para lo que sirve el color.
 *
 * Se usan elementos del DOM en lugar de <canvas> para que las cajas
 * puedan transicionar con CSS. A 5 fps, un canvas redibujado daría
 * saltos perceptibles; una transición de 120 ms sobre `transform` hace
 * que la caja "siga" al rostro con suavidad, sin que el backend tenga
 * que enviar más frames.
 */
export function FaceOverlay({
  faces,
  sourceWidth,
  sourceHeight,
  videoRef,
  mirrored = true,
  suspicious = false,
}: FaceOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState({ x: 1, y: 1, offsetX: 0, offsetY: 0 });

  /**
   * Calcula la transformación entre las coordenadas del frame analizado
   * y los píxeles que ocupa el vídeo en pantalla.
   *
   * El <video> usa object-fit: cover, así que puede haber recorte: hay
   * que replicar aquí ese mismo cálculo o las cajas quedarían desplazadas.
   */
  useEffect(() => {
    const update = () => {
      const video = videoRef.current;
      const container = containerRef.current;
      if (!video || !container || !sourceWidth || !sourceHeight) return;

      const box = container.getBoundingClientRect();
      const containerRatio = box.width / box.height;
      const sourceRatio = sourceWidth / sourceHeight;

      let renderedWidth: number;
      let renderedHeight: number;

      if (containerRatio > sourceRatio) {
        // El contenedor es más ancho: el vídeo se recorta arriba y abajo.
        renderedWidth = box.width;
        renderedHeight = box.width / sourceRatio;
      } else {
        renderedWidth = box.height * sourceRatio;
        renderedHeight = box.height;
      }

      setScale({
        x: renderedWidth / sourceWidth,
        y: renderedHeight / sourceHeight,
        offsetX: (box.width - renderedWidth) / 2,
        offsetY: (box.height - renderedHeight) / 2,
      });
    };

    update();
    const observer = new ResizeObserver(update);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [sourceWidth, sourceHeight, videoRef]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      {faces.map((face, index) => {
        const width = face.bbox.width * scale.x;
        const height = face.bbox.height * scale.y;
        const top = face.bbox.y * scale.y + scale.offsetY;

        // El vídeo se muestra en espejo (como un espejo real), así que
        // la coordenada X debe invertirse para que la caja coincida.
        const left = mirrored
          ? scale.offsetX +
            (sourceWidth - face.bbox.x - face.bbox.width) * scale.x
          : face.bbox.x * scale.x + scale.offsetX;

        // El significado del color NO cambia con el rediseño: verde es
        // persona registrada, rojo desconocida y naranja sospecha de
        // suplantación. Es la información más importante de la pantalla
        // y no debe depender de la moda visual del momento.
        //
        // La sospecha gana a las otras dos a propósito. Es el único
        // caso en el que un rostro RECONOCIDO no se pinta de verde, y
        // tiene que ser así: lo que hay delante puede ser una foto de
        // alguien que sí está registrado.
        const color = suspicious
          ? 'var(--color-vault-orange)'
          : face.recognized
            ? 'var(--color-vault-green)'
            : 'var(--color-denied)';

        return (
          <div
            key={`${face.personId ?? 'unknown'}-${index}`}
            className="absolute transition-all duration-150 ease-out"
            style={{
              left: `${left}px`,
              top: `${top}px`,
              width: `${width}px`,
              height: `${height}px`,
            }}
          >
            {/* Marco de neón: halo hacia fuera y hacia dentro */}
            <div
              className="absolute inset-0 rounded-xl border-2"
              style={{
                borderColor: color,
                boxShadow: `0 0 24px -2px ${color}, inset 0 0 24px -8px ${color}`,
              }}
            />

            {/* Esquinas, para un aspecto de visor técnico */}
            {(
              [
                'top-0 left-0 border-t-4 border-l-4 rounded-tl-lg',
                'top-0 right-0 border-t-4 border-r-4 rounded-tr-lg',
                'bottom-0 left-0 border-b-4 border-l-4 rounded-bl-lg',
                'bottom-0 right-0 border-b-4 border-r-4 rounded-br-lg',
              ] as const
            ).map((cls) => (
              <div
                key={cls}
                className={`absolute h-5 w-5 ${cls}`}
                style={{ borderColor: color }}
              />
            ))}

            {/* Etiqueta flotante sobre la caja */}
            <div
              className="absolute -top-9 left-0 flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs font-semibold text-white backdrop-blur-md"
              style={{
                borderColor: color,
                backgroundColor: `color-mix(in oklab, ${color} 30%, transparent)`,
                boxShadow: `0 0 20px -6px ${color}`,
              }}
            >
              {/*
                CON SOSPECHA NO SE ENSEÑA EL NOMBRE NI EL PORCENTAJE, y
                no es por estética. Una foto en una pantalla se reconoce
                perfectamente; mostrar «diego ossa 76 %» encima de un
                intento de suplantación le estaría confirmando a quien lo
                intenta que su foto ya sirve para el reconocimiento y que
                solo le falta sortear la detección de vida.

                Quien investiga el incidente sí ve la identidad: queda en
                el registro de accesos y en el panel del operador.
              */}
              {suspicious ? (
                <>
                  <span>⚠</span>
                  <span>Posible suplantación</span>
                </>
              ) : (
                <>
                  <span>{face.recognized ? '✓' : '✕'}</span>
                  <span>{face.personName ?? 'Desconocido'}</span>
                  {face.recognized && (
                    <span className="opacity-80">
                      {Math.round(face.confidence * 100)}%
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
