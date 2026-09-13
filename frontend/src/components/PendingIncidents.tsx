import { CircleAlert, ClipboardList } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api, type PendingIncident } from '@/lib/api';

/**
 * Lo que dejó sin cerrar el turno anterior.
 *
 * ES LA RAZON DE QUE LA BITACORA EXISTA
 * ─────────────────────────────────────
 * Un registro de partes que solo se pudiera leer parte por parte
 * obligaría a repasar el turno anterior entero para enterarse de que el
 * ascensor sigue roto. Lo que hace falta al llegar es la lista corta de
 * lo que no está cerrado, y este es el momento exacto en que hace
 * falta: acabas de identificarte y vas a empezar a trabajar.
 *
 * NO FILTRA POR PERSONA, Y ES EL PUNTO
 * ────────────────────────────────────
 * Lo pendiente lo dejó otro. Es la única parte de `/me` que enseña algo
 * que no es tuyo, y se puede porque es exactamente lo que un relevo de
 * turno significa.
 *
 * SI FALLA, NO SE VE NADA Y YA ESTA
 * ─────────────────────────────────
 * No se pinta un error: esta tarjeta es un extra sobre la pantalla de
 * jornada, y un aviso rojo aquí haría pensar que hay un problema con el
 * fichaje de quien acaba de entrar.
 */
export function PendingIncidents() {
  const [items, setItems] = useState<PendingIncident[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const respuesta = await api.pendingIncidents();
        if (!cancelled) setItems(respuesta.items);
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Mientras carga, y cuando no hay nada pendiente, no ocupa sitio. Una
  // tarjeta vacía que dice «nada pendiente» es ruido en una pantalla
  // que se mira dos segundos.
  if (!items || items.length === 0) return null;

  return (
    <section className="mt-7 border-t border-white/8 pt-5">
      <h2 className="mb-3 flex items-center gap-1.5 text-xs font-medium tracking-widest text-white/35 uppercase">
        <ClipboardList className="h-3.5 w-3.5" />
        Queda pendiente del turno anterior
      </h2>

      <ul className="space-y-2.5">
        {items.map((incidencia) => (
          <li
            key={incidencia.id}
            className="rounded-xl border border-white/8 bg-white/[0.03] px-3.5 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-white/80">{incidencia.title}</p>
              <span className="mt-0.5 shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[10px] tracking-wide text-white/45 uppercase">
                {incidencia.severity}
              </span>
            </div>

            <p className="mt-1 text-xs text-white/35">
              {incidencia.category.toLowerCase()} · lo dejó{' '}
              {incidencia.entry.personName}
              {incidencia.mentionedTime ? ` (${incidencia.mentionedTime})` : ''}
            </p>

            {incidencia.quote && !incidencia.quoteVerified && (
              // La marca viaja desde el Voice Service hasta aquí: es lo
              // único que el sistema sabe detectar sobre la invención de
              // un modelo, y quien lo lee tiene que poder distinguirlo.
              <p className="mt-1.5 flex items-center gap-1 text-[11px] text-vault-orange">
                <CircleAlert className="h-3 w-3" />
                Esta incidencia no está respaldada por lo que se dictó
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
