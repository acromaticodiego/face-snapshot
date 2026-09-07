import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

/**
 * Alternador de tema.
 *
 * Arranca respetando la preferencia del sistema y recuerda la elección
 * del usuario. En una pantalla de acceso montada en un vestíbulo, el
 * modo oscuro reduce el deslumbramiento y hace que el vídeo destaque.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);
  }, [theme]);

  return (
    <button
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      aria-label={theme === 'dark' ? 'Activar tema claro' : 'Activar tema oscuro'}
      className="fixed top-4 right-4 z-40 rounded-lg border border-surface-200 bg-white/80 p-2 text-surface-700 shadow-sm backdrop-blur transition-colors hover:bg-surface-100 dark:border-surface-800 dark:bg-surface-900/80 dark:text-surface-300 dark:hover:bg-surface-800"
    >
      {theme === 'dark' ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </button>
  );
}
