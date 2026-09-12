import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Combina clases de Tailwind resolviendo conflictos.
 * `cn('p-2', 'p-4')` devuelve 'p-4', no ambas.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Convierte segundos en "6 h 42 min".
 *
 * El backend cuenta en segundos para no perder minutos al redondear en
 * cada transición; aquí se redondea una sola vez, al mostrarlo, que es
 * donde el segundo suelto no le importa a nadie.
 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours === 0) return `${minutes} min`;
  return `${hours} h ${String(minutes).padStart(2, '0')} min`;
}

/** Hora local en formato 24 h: "08:14". */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Saludo según la hora.
 *
 * Usa la hora del navegador y no la de la sede a propósito: quien lee
 * esto está delante del terminal, así que su reloj y el de la pared
 * dicen lo mismo. La hora de la sede importa para *contabilizar* la
 * jornada, no para saludar.
 */
export function greetingFor(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Buenos días';
  if (hour < 20) return 'Buenas tardes';
  return 'Buenas noches';
}
