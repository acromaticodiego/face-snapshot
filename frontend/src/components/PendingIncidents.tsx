import { Check, CircleAlert, ClipboardList, Loader2 } from 'lucide-react';
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
 * Y POR ESO CUALQUIERA PUEDE CERRARLO
 * ───────────────────────────────────
 * Quien cierra no tiene por qué ser quien lo abrió: el del turno
 * siguiente es precisamente quien puede comprobar que el ascensor ya
 * funciona. Queda registrado quién fue, que es lo que hace que esto no
 * sea un botón de borrar.
 *
 * Cerrar NO edita la incidencia. El servidor escribe una resolución que
 * la referencia, porque vive dentro de un parte firmado y un parte
 * firmado no se toca (ADR 0012).
 *
 * SI FALLA, NO SE VE NADA Y YA ESTA
 * ─────────────────────────────────
 * No se pinta un error al cargar: esta tarjeta es un extra sobre la
 * pantalla de jornada, y un aviso rojo aquí haría pensar que hay un
 * problema con el fichaje de quien acaba de entrar.
 */
export function PendingIncidents() {
  const [items, setItems] = useState<PendingIncident[] | null>(null);
  /** Incidencias que se están cerrando ahora mismo. */
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);

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

  /**
   * Cierra una incidencia y la quita de la lista.
   *
   * SE QUITA CUANDO EL SERVIDOR CONFIRMA, no antes. Un optimismo aquí
   * haría desaparecer de la pantalla algo que sigue pendiente si la
   * petición falla, y lo que se pierde es justo lo que esta tarjeta
   * existe para no perder.
   *
   * Que otra persona la hubiera cerrado ya NO es un error: el servidor
   * responde `alreadyResolved` y aquí se trata igual que un cierre
   * propio, porque el resultado que importa —ya no está pendiente— es
   * el mismo.
   */
  const cerrar = async (id: string) => {
    setFailed(null);
    setClosing((previo) => new Set(previo).add(id));

    try {
      await api.resolveIncident(id);
      setItems((previo) => (previo ?? []).filter((i) => i.id !== id));
    } catch {
      setFailed(id);
    } finally {
      setClosing((previo) => {
        const siguiente = new Set(previo);
        siguiente.delete(id);
        return siguiente;
      });
    }
  };

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
        {items.map((incidencia) => {
          const cerrando = closing.has(incidencia.id);

          return (
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
                {incidencia.mentionedTime
                  ? ` (${incidencia.mentionedTime})`
                  : ''}
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

              <div className="mt-2.5 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void cerrar(incidencia.id)}
                  disabled={cerrando}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-white/60 transition-colors hover:border-vault-green/50 hover:text-vault-green disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {cerrando ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  {cerrando ? 'Cerrando...' : 'Ya está resuelto'}
                </button>

                {failed === incidencia.id && (
                  <span className="text-[11px] text-denied">
                    No se pudo cerrar. Sigue pendiente.
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
