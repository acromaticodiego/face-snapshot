import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * Preparación común de los tests del frontend.
 *
 * Cada test monta su propio árbol de React; sin `cleanup` los restos del
 * anterior siguen en el documento y una consulta como "busca el botón
 * de descanso" encontraría el del test de antes. El síntoma es un test
 * que pasa solo cuando se ejecuta aislado.
 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * `matchMedia` no existe en jsdom y algunos componentes lo consultan.
 * Sin este doble, montar el árbol revienta con un TypeError que no
 * tiene nada que ver con lo que se está probando.
 */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
