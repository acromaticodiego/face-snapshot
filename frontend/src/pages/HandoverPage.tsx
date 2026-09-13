import {
  ArrowLeft,
  Check,
  CircleAlert,
  Mic,
  PenLine,
  Plus,
  ScanFace,
  Square,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import {
  GlassCard,
  GlowBadge,
  VaultBackground,
  VaultButton,
  VaultTitle,
} from '@/components/vault';
import { useRecorder } from '@/hooks/useRecorder';
import {
  api,
  ApiError,
  type IncidentCategory,
  type IncidentSeverity,
  type LogbookDraft,
  type ShiftSummary,
} from '@/lib/api';
import {
  BLOCKING_MESSAGES,
  blockingReason,
  defaultPeriod,
  emptyIncident,
  fromProposed,
  originOf,
  toPayload,
  type EditableIncident,
} from '@/lib/handover';
import { formatTime } from '@/lib/utils';

const CATEGORIES: IncidentCategory[] = [
  'ACCESO',
  'ALARMA',
  'MANTENIMIENTO',
  'SEGURIDAD',
  'OTRO',
];
const SEVERITIES: IncidentSeverity[] = ['BAJA', 'MEDIA', 'ALTA'];

/**
 * Dictar, revisar y FIRMAR un parte de relevo de turno.
 *
 * LA PANTALLA ENTERA EXISTE POR EL PASO DEL MEDIO
 * ───────────────────────────────────────────────
 * Transcribir y estructurar los hace el backend. Lo que solo puede
 * pasar aquí es que **una persona lea lo que el modelo propuso y decida
 * si es verdad**. Nada se guarda hasta que pulsa firmar, y lo que firma
 * es inmutable.
 *
 * Por eso el borrador vive en memoria y no en la base de datos: un
 * registro de seguridad a medio hacer, que nadie ha leído y que parece
 * un parte, es peor que no tener parte.
 *
 * SE PUEDE LLEGAR AL FINAL SIN MICROFONO Y SIN MODELO
 * ───────────────────────────────────────────────────
 * Si la transcripción no está disponible se escribe a mano, y si el
 * estructurador no responde queda la transcripción y las incidencias se
 * añaden a mano. Un vigilante que termina su turno no puede irse sin
 * dejar constancia porque un proveedor externo esté caído.
 */
export function HandoverPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as { name?: string };

  const recorder = useRecorder();

  const [shift, setShift] = useState<ShiftSummary | null>(null);
  const [loadingShift, setLoadingShift] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [signing, setSigning] = useState(false);

  /** El borrador. `null` mientras no se haya dictado ni escrito nada. */
  const [transcript, setTranscript] = useState<string | null>(null);
  const [models, setModels] = useState<{
    transcription: string | null;
    structuring: string | null;
  }>({ transcription: null, structuring: null });
  const [summary, setSummary] = useState('');
  const [incidents, setIncidents] = useState<EditableIncident[]>([]);
  const [started, setStarted] = useState(false);
  const [structureNote, setStructureNote] = useState<string | null>(null);

  /**
   * La sesión facial caducó mientras se estaba en esta pantalla.
   *
   * Es un estado propio y no un aviso pasajero porque **no hay nada que
   * se pueda hacer desde aquí**: el token dura 15 minutos y sin él no
   * se transcribe ni se firma. Un toast que desaparece deja a alguien
   * mirando un botón que no va a funcionar nunca.
   */
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const current = await api.myShift();
        if (!cancelled) setShift(current);
      } catch {
        // Sin jornada no se puede firmar, y la pantalla lo dirá. No se
        // molesta con un error aparte por algo que ya se ve.
      } finally {
        if (!cancelled) setLoadingShift(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyDraft = useCallback((draft: LogbookDraft) => {
    setTranscript(draft.transcripcion.texto);
    setModels({
      transcription: draft.transcripcion.modelo,
      // La VERSION concreta que devuelve el servicio, no la marca:
      // es lo que permite rastrear qué partes pasaron por un modelo
      // concreto si algún día resulta que agrupaba mal.
      structuring: draft.modeloEstructurador,
    });
    setStructureNote(draft.estructuraOmitidaPor);

    if (draft.estructura) {
      setSummary(draft.estructura.resumen);
      setIncidents(
        draft.estructura.incidencias.map((propuesta, i) =>
          fromProposed(propuesta, `p${i}-${Date.now()}`),
        ),
      );
    } else {
      // Sin estructura, la transcripción sirve de punto de partida para
      // el resumen: es preferible a dejarlo en blanco después de haber
      // dictado dos minutos.
      setSummary(draft.transcripcion.texto);
      setIncidents([]);
    }
    setStarted(true);
  }, []);

  const handleRecord = async () => {
    if (!recorder.isRecording) {
      await recorder.start();
      return;
    }

    const audio = await recorder.stop();
    if (!audio) {
      toast.error('No se grabó nada');
      return;
    }

    setDrafting(true);
    try {
      applyDraft(await api.logbookDraft(audio));
    } catch (err) {
      // El 503 del Voice Service llega con su código Y con un motivo
      // concreto, y los dos importan: el código dice qué hacer
      // —escribirlo a mano— y el motivo dice POR QUÉ, que es lo único
      // que permite arreglarlo.
      //
      // La primera versión de esto aplastaba los dos casos en un
      // mensaje fijo, y se notó en cuanto se probó de verdad: «no se
      // reconoció ninguna palabra en el audio» y «no se pudo contactar
      // con el servicio» llevan a acciones opuestas —revisar el
      // micrófono o avisar de que algo está caído— y decir lo mismo en
      // los dos manda a buscar donde no es.
      if (err instanceof ApiError && err.status === 401) {
        setExpired(true);
        return;
      }

      const sinTranscripcion =
        err instanceof ApiError && err.code === 'TRANSCRIPTION_UNAVAILABLE';
      toast.error(
        sinTranscripcion
          ? `${(err as ApiError).message}. Escribe el parte a mano.`
          : err instanceof ApiError
            ? err.message
            : 'No se pudo preparar el borrador',
      );
      if (sinTranscripcion) startByHand();
    } finally {
      setDrafting(false);
    }
  };

  const startByHand = () => {
    setTranscript(null);
    setModels({ transcription: null, structuring: null });
    setStructureNote(null);
    setStarted(true);
  };

  const updateIncident = (key: string, cambios: Partial<EditableIncident>) => {
    setIncidents((prev) =>
      prev.map((i) => (i.key === key ? { ...i, ...cambios } : i)),
    );
  };

  const blocked = blockingReason({
    siteId: shift?.siteId ?? null,
    summary,
    incidents,
  });

  const handleSign = async () => {
    if (blocked || !shift?.siteId) return;

    setSigning(true);
    try {
      const periodo = defaultPeriod(shift.startedAt);
      const parte = await api.signHandover(
        toPayload({
          siteId: shift.siteId,
          ...periodo,
          transcript,
          summary,
          transcriptionModel: models.transcription,
          structuringModel: models.structuring,
          incidents,
        }),
      );

      toast.success(
        parte.incidents.length === 0
          ? 'Parte firmado, sin incidencias'
          : `Parte firmado con ${parte.incidents.length} incidencia(s)`,
      );
      navigate('/home', { replace: true, state });
    } catch (err) {
      // Aquí duele más que al dictar: hay un parte revisado en pantalla
      // que ya no se puede enviar. Se avisa con el estado, no con un
      // toast, para que lo escrito siga a la vista mientras se decide
      // qué hacer.
      if (err instanceof ApiError && err.status === 401) {
        setExpired(true);
        return;
      }
      toast.error(
        err instanceof ApiError ? err.message : 'No se pudo firmar el parte',
      );
    } finally {
      setSigning(false);
    }
  };

  // A esta pantalla se llega desde /home, que a su vez exige haberse
  // identificado. Igual que allí: comodidad de navegación, no
  // seguridad — los datos los protege el token.
  if (!state.name) return <Navigate to="/" replace />;

  const sinJornada = !loadingShift && !shift?.siteId;

  return (
    <div className="relative flex min-h-dvh items-start justify-center bg-vault-bg px-4 py-10">
      <VaultBackground />

      <div className="animate-fade-up relative z-10 w-full max-w-2xl">
        <header className="mb-6">
          <button
            type="button"
            onClick={() => navigate('/home', { state })}
            className="mb-3 inline-flex items-center gap-1.5 text-xs text-white/40 transition hover:text-white/70"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Volver
          </button>
          <VaultTitle className="text-balance">Parte de relevo</VaultTitle>
          <p className="mt-1 text-sm text-white/40">
            Cuenta lo que ha pasado en tu turno. Lo revisas antes de firmarlo.
          </p>
        </header>

        {/* La sesión caducada se avisa ANTES que nada y no se quita:
            sin token no se transcribe ni se firma, y lo único que
            resuelve es volver a pasar por la cámara. */}
        {expired && (
          <GlassCard className="mb-4 border-vault-orange/30 p-5">
            <p className="flex items-start gap-2 text-sm text-vault-orange">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              Tu sesión ha caducado. Dura 15 minutos desde que te
              identificaste.
            </p>
            <p className="mt-2 text-xs text-white/40">
              Vuelve a pasar por la cámara y dicta el parte a continuación.
              {started && ' Lo que hay escrito aquí se perderá.'}
            </p>
            <VaultButton
              tone="blue"
              className="mt-4 w-full"
              onClick={() => navigate('/', { replace: true })}
              icon={<ScanFace className="h-4 w-4" />}
            >
              Volver a identificarme
            </VaultButton>
          </GlassCard>
        )}

        {sinJornada ? (
          <GlassCard className="p-6">
            {/* Sin jornada abierta no hay sede a la que imputar el parte
                ni periodo que cubra. Se dice el motivo y qué hacer, no
                solo que no se puede. */}
            <p className="text-sm text-white/70">
              {BLOCKING_MESSAGES.SIN_JORNADA}
            </p>
            <p className="mt-2 text-xs text-white/35">
              Si ya has fichado la salida, el parte de este turno tenía que
              quedar dictado antes de pasar por la puerta.
            </p>
          </GlassCard>
        ) : !started ? (
          <GlassCard className="p-6 sm:p-8">
            <div className="flex flex-col items-center gap-5 py-4">
              <VaultButton
                tone={recorder.isRecording ? 'danger' : 'blue'}
                loading={drafting}
                onClick={() => void handleRecord()}
                icon={
                  recorder.isRecording ? (
                    <Square className="h-4 w-4" />
                  ) : (
                    <Mic className="h-4 w-4" />
                  )
                }
              >
                {recorder.isRecording
                  ? `Detener (${recorder.seconds}s)`
                  : drafting
                    ? 'Preparando el borrador…'
                    : 'Dictar el parte'}
              </VaultButton>

              <p className="max-w-sm text-center text-xs text-white/35">
                {recorder.isRecording
                  ? 'Habla con normalidad. Di las horas como las dirías en voz alta.'
                  : 'Al terminar, el sistema propone un resumen y una lista de incidencias. Nada se guarda hasta que firmes.'}
              </p>

              {recorder.error && (
                <p className="rounded-lg border border-denied/40 bg-denied/10 px-3 py-2 text-xs text-denied">
                  {recorder.error}
                </p>
              )}

              <button
                type="button"
                onClick={startByHand}
                className="inline-flex items-center gap-1.5 text-xs text-white/40 underline-offset-4 transition hover:text-white/70 hover:underline"
              >
                <PenLine className="h-3.5 w-3.5" />
                Escribirlo a mano
              </button>
            </div>
          </GlassCard>
        ) : (
          <div className="space-y-4">
            {/* ── Lo que se dijo ──────────────────────────────── */}
            {transcript && (
              <GlassCard className="p-5">
                <h2 className="mb-2 text-xs font-medium tracking-widest text-white/35 uppercase">
                  Lo que dijiste
                </h2>
                {/* No es editable a propósito: es el registro de lo que
                    se dijo. El resumen y las incidencias sí se corrigen;
                    la transcripción es la que zanja las discusiones. */}
                <p className="max-h-40 overflow-y-auto text-sm leading-relaxed text-white/60">
                  {transcript}
                </p>
              </GlassCard>
            )}

            {structureNote && (
              <p className="flex items-start gap-2 rounded-lg border border-vault-orange/30 bg-vault-orange/10 px-3 py-2 text-xs text-vault-orange">
                <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                {structureNote}. Revisa el resumen y añade las incidencias a
                mano.
              </p>
            )}

            {/* ── Resumen ─────────────────────────────────────── */}
            <GlassCard className="p-5">
              <label className="block">
                <span className="mb-2 block text-xs font-medium tracking-widest text-white/35 uppercase">
                  Resumen del turno
                </span>
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  rows={3}
                  placeholder="Qué ha pasado en tu turno, en dos o tres frases."
                  className="w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3.5 py-3 text-sm text-white placeholder:text-white/25 focus:border-vault-blue/60 focus:outline-none"
                />
              </label>
            </GlassCard>

            {/* ── Incidencias ─────────────────────────────────── */}
            <GlassCard className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-medium tracking-widest text-white/35 uppercase">
                  Incidencias ({incidents.length})
                </h2>
                <VaultButton
                  tone="glass"
                  size="sm"
                  onClick={() =>
                    setIncidents((prev) => [
                      ...prev,
                      emptyIncident(`m${Date.now()}`),
                    ])
                  }
                  icon={<Plus className="h-3.5 w-3.5" />}
                >
                  Añadir
                </VaultButton>
              </div>

              {incidents.length === 0 ? (
                <p className="py-2 text-xs text-white/30">
                  Ninguna. Un turno sin novedades es un parte válido: no hace
                  falta inventarse una.
                </p>
              ) : (
                <ul className="space-y-3">
                  {incidents.map((incidencia) => (
                    <IncidentRow
                      key={incidencia.key}
                      incidencia={incidencia}
                      onChange={(cambios) =>
                        updateIncident(incidencia.key, cambios)
                      }
                      onRemove={() =>
                        setIncidents((prev) =>
                          prev.filter((i) => i.key !== incidencia.key),
                        )
                      }
                    />
                  ))}
                </ul>
              )}
            </GlassCard>

            {/* ── Firmar ──────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <VaultButton
                tone="blue"
                className="w-full"
                loading={signing}
                disabled={Boolean(blocked)}
                onClick={() => void handleSign()}
                icon={<Check className="h-4 w-4" />}
              >
                Firmar el parte
              </VaultButton>

              <p className="text-center text-[11px] text-white/30">
                {blocked
                  ? BLOCKING_MESSAGES[blocked]
                  : shift?.startedAt
                    ? `Cubre desde las ${formatTime(shift.startedAt)} hasta ahora. Una vez firmado no se puede editar.`
                    : 'Una vez firmado no se puede editar.'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Una incidencia en revisión.
 *
 * La cita y su marca de respaldo se muestran y NO se editan: describen
 * lo que hizo el modelo, no lo que decide la persona. Cambiarlas sería
 * poder borrar la prueba de que se inventó algo.
 */
function IncidentRow({
  incidencia,
  onChange,
  onRemove,
}: {
  incidencia: EditableIncident;
  onChange: (cambios: Partial<EditableIncident>) => void;
  onRemove: () => void;
}) {
  const origen = originOf(incidencia);

  return (
    <GlassCard as="li" className="p-3.5">
      <div className="flex items-start gap-2">
        <input
          value={incidencia.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Qué pasó"
          aria-label="Título de la incidencia"
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/25 focus:border-vault-blue/60 focus:outline-none"
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Quitar ${incidencia.title || 'incidencia'}`}
          className="mt-1 shrink-0 rounded-lg p-1.5 text-white/30 transition hover:bg-denied/10 hover:text-denied"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <select
          value={incidencia.category}
          onChange={(e) =>
            onChange({ category: e.target.value as IncidentCategory })
          }
          aria-label="Categoría"
          className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/80 focus:border-vault-blue/60 focus:outline-none"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c} className="bg-vault-bg">
              {c}
            </option>
          ))}
        </select>

        <select
          value={incidencia.severity}
          onChange={(e) =>
            onChange({ severity: e.target.value as IncidentSeverity })
          }
          aria-label="Gravedad"
          className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/80 focus:border-vault-blue/60 focus:outline-none"
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s} className="bg-vault-bg">
              {s}
            </option>
          ))}
        </select>

        <input
          value={incidencia.mentionedTime}
          onChange={(e) => onChange({ mentionedTime: e.target.value })}
          placeholder="a qué hora"
          aria-label="Hora mencionada"
          className="w-32 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/80 placeholder:text-white/25 focus:border-vault-blue/60 focus:outline-none"
        />

        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-white/60">
          <input
            type="checkbox"
            checked={incidencia.requiresFollowUp}
            onChange={(e) => onChange({ requiresFollowUp: e.target.checked })}
            className="accent-vault-orange"
          />
          Queda pendiente
        </label>
      </div>

      {incidencia.quote && (
        <div className="mt-2.5 border-l-2 border-white/10 pl-2.5">
          <p className="text-xs leading-relaxed text-white/40 italic">
            «{incidencia.quote}»
          </p>
          {!incidencia.quoteVerified && (
            // Lo único que este sistema sabe detectar sobre la invención
            // de un modelo: que no pudo señalar dónde lo leyó. Tiene que
            // verse antes de firmar, no después.
            <p className="mt-1 flex items-center gap-1 text-[11px] text-vault-orange">
              <CircleAlert className="h-3 w-3" />
              Esta cita no aparece en lo que dijiste
            </p>
          )}
        </div>
      )}

      {origen !== 'PROPUESTA_ACEPTADA' && (
        <div className="mt-2">
          <GlowBadge accent={origen === 'PROPUESTA_EDITADA' ? 'orange' : 'purple'}>
            {origen === 'PROPUESTA_EDITADA' ? 'Corregida por ti' : 'Añadida por ti'}
          </GlowBadge>
        </div>
      )}
    </GlassCard>
  );
}
