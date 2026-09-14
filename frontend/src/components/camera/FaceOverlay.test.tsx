import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { FaceVerdict } from '@/lib/api';

import { FaceOverlay } from './FaceOverlay';

/**
 * Las cajas que se dibujan sobre el vídeo del terminal.
 *
 * LO QUE ESTE ARCHIVO PROTEGE NO ES EL DISEÑO
 * ───────────────────────────────────────────
 * Es una regla de seguridad que solo vive en este JSX: **cuando hay
 * sospecha de suplantación, la identidad NO se enseña en pantalla.**
 *
 * Una foto en la pantalla de un móvil se reconoce perfectamente —al
 * 76 % en la prueba del 2026-09-14, con el acceso denegado por la
 * detección de vida—. Si en ese momento la etiqueta dijera «diego ossa
 * 76 %», le estaría confirmando a quien lo intenta que su foto ya sirve
 * para el reconocimiento y que lo único que le falta es sortear la
 * detección de vida. Es exactamente el dato que no hay que darle.
 *
 * Quien investiga el incidente sí ve la identidad: queda en el registro
 * de accesos y en el panel del operador. Lo que no puede verse es en la
 * pantalla que mira el atacante.
 *
 * El color se comprueba por el mismo motivo: verde sobre un intento de
 * suplantación diría lo contrario de lo que está pasando.
 */

/**
 * `ResizeObserver` no existe en jsdom, y el componente lo usa para
 * recalcular la escala cuando cambia el tamano del video.
 *
 * Se sustituye por uno que no hace nada, y eso no invalida estas
 * pruebas: lo que se comprueba aqui es QUE se pinta -texto y color-,
 * no DONDE. La posicion depende de medidas del DOM que jsdom devuelve
 * en cero de todas formas, asi que probarla aqui daria una falsa
 * sensacion de cobertura.
 */
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const rostroReconocido: FaceVerdict = {
  bbox: { x: 10, y: 10, width: 100, height: 120 },
  recognized: true,
  personName: 'diego ossa',
  personId: 'p-1',
  confidence: 0.76,
};

const rostroDesconocido: FaceVerdict = {
  bbox: { x: 10, y: 10, width: 100, height: 120 },
  recognized: false,
  personName: null,
  personId: null,
  confidence: 0.12,
};

function pintar(faces: FaceVerdict[], suspicious = false) {
  const videoRef = createRef<HTMLVideoElement>();
  const { container } = render(
    <>
      <video ref={videoRef} />
      <FaceOverlay
        faces={faces}
        sourceWidth={640}
        sourceHeight={360}
        videoRef={videoRef}
        suspicious={suspicious}
      />
    </>,
  );
  return container;
}

/** Los colores que aparecen en los estilos en linea de las cajas. */
function colores(container: HTMLElement): string {
  return Array.from(container.querySelectorAll<HTMLElement>('[style]'))
    .map((el) => el.getAttribute('style') ?? '')
    .join(' ');
}

describe('FaceOverlay', () => {
  it('con un rostro reconocido enseña el nombre y el porcentaje', () => {
    pintar([rostroReconocido]);
    expect(screen.getByText('diego ossa')).toBeInTheDocument();
    expect(screen.getByText('76%')).toBeInTheDocument();
  });

  it('con un rostro desconocido lo dice', () => {
    pintar([rostroDesconocido]);
    expect(screen.getByText('Desconocido')).toBeInTheDocument();
  });

  it('CON SOSPECHA NO ENSEÑA LA IDENTIDAD, aunque la reconozca', () => {
    // El caso real: una foto de alguien registrado. El reconocimiento
    // acierta y la detección de vida lo para. La pantalla no puede
    // confirmarle al atacante que la primera mitad ya le funciona.
    pintar([rostroReconocido], true);

    expect(screen.getByText('Posible suplantación')).toBeInTheDocument();
    expect(screen.queryByText('diego ossa')).not.toBeInTheDocument();
    expect(screen.queryByText('76%')).not.toBeInTheDocument();
  });

  it('con sospecha la caja es NARANJA, no verde', () => {
    // Verde significa «persona registrada, adelante». Pintar de verde
    // una foto diría lo contrario de lo que acaba de pasar.
    const estilos = colores(pintar([rostroReconocido], true));
    expect(estilos).toContain('--color-vault-orange');
    expect(estilos).not.toContain('--color-vault-green');
  });

  it('sin sospecha, un rostro reconocido sigue siendo verde', () => {
    const estilos = colores(pintar([rostroReconocido]));
    expect(estilos).toContain('--color-vault-green');
    expect(estilos).not.toContain('--color-vault-orange');
  });

  it('sin sospecha, un desconocido sigue siendo rojo', () => {
    const estilos = colores(pintar([rostroDesconocido]));
    expect(estilos).toContain('--color-denied');
    expect(estilos).not.toContain('--color-vault-orange');
  });
});
