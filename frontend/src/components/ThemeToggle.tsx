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
      className="fixed top-4 right-4 z-40 rounded-xl border border-white/12 bg-white/[0.06] p-2 text-white/60 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.08)] backdrop-blur-xl transition-colors hover:border-white/25 hover:text-white"
    >
      {theme === 'dark' ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </button>
  );
}
