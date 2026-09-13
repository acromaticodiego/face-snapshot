import {
  AlertCircle,
  Camera,
  Check,
  CheckCircle2,
  IdCard,
  ShieldCheck,
  User,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { GlassCard, GlassField, VaultButton } from '@/components/vault';
import { useCamera } from '@/hooks/useCamera';
import { api, ApiError, type Person, type Role } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Alta de una persona, de principio a fin.
 *
 * POR QUE ES UN ASISTENTE Y NO UN FORMULARIO
 * ──────────────────────────────────────────
 * Dar de alta a alguien son tres escrituras en DOS servicios distintos
 * —la identidad vive en el Face Service, el rol en el Access Service— y
 * no hay ninguna transacción que las abarque. Si el alta se queda a
 * medias, lo que queda es un registro que el sistema reconoce y al que
 * no deja pasar por ninguna puerta: exactamente los seis casos que hoy
 * encabezan las denegaciones por `NO_ROLE_ASSIGNED`.
 *
 * La respuesta no es intentar una transacción distribuida para tres
 * llamadas, sino hacer el estado incompleto VISIBLE y RETOMABLE. Por
 * eso el mismo diálogo sirve para el alta completa y para entrar
 * directo al paso que le falte a alguien que ya existe, con
 * `initialStep`.
 *
 * POR QUE EL ROSTRO VA EL ULTIMO
 * ──────────────────────────────
 * Es el paso lento y el que más falla: depende de la cámara, de la luz
 * y de la calidad de la toma. Dejarlo al final significa que una
 * interrupción deja a la persona creada y con rol —un estado ya
 * visible en la lista y que se retoma en un clic—, en lugar de dejar un
 * rostro enrolado que no puede abrir nada.
 */

interface PersonOnboardingDialogProps {
  /** Si viene, se retoma el alta de alguien que ya existe. */
  person?: Person | null;
  initialStep?: Step;
  onClose: () => void;
  /** Se llama al terminar, y también al cerrar tras haber cambiado algo. */
  onFinished: () => void;
}

type Step = 'datos' | 'rol' | 'rostro';

const STEPS: { id: Step; label: string }[] = [
  { id: 'datos', label: 'Datos' },
  { id: 'rol', label: 'Rol' },
  { id: 'rostro', label: 'Rostro' },
];

export function PersonOnboardingDialog({
  person: existing = null,
  initialStep = 'datos',
  onClose,
  onFinished,
}: PersonOnboardingDialogProps) {
  const [step, setStep] = useState<Step>(initialStep);
  const [person, setPerson] = useState<Person | null>(existing);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Si algo se llegó a escribir. Al cerrar a medias hay que refrescar
   * la lista igualmente: la persona ya existe y tiene que verse, aunque
   * le falte un paso.
   */
  const [dirty, setDirty] = useState(false);

  // ── Paso 1: datos ───────────────────────────────────────────────
  const [fullName, setFullName] = useState('');
  const [externalId, setExternalId] = useState('');

  // ── Paso 2: rol ─────────────────────────────────────────────────
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  // ── Paso 3: rostro ──────────────────────────────────────────────
  const camera = useCamera({ width: 1280, height: 720 });
  const [preview, setPreview] = useState<string | null>(null);
  const [captured, setCaptured] = useState<Blob | null>(null);
  const [enrolled, setEnrolled] = useState(false);

  const close = useCallback(() => {
    if (dirty) onFinished();
    else onClose();
  }, [dirty, onClose, onFinished]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // El catálogo de roles se pide una vez al abrir, no al llegar al paso
  // 2: así el salto entre pasos es instantáneo y un fallo de red se ve
  // antes de haber creado a nadie.
  useEffect(() => {
    let cancelled = false;
    void api
      .listRoles()
      .then((data) => {
        if (cancelled) return;
        setRoles(data.items.filter((role) => role.isActive));
      })
      .catch(() => {
        if (!cancelled) setRoles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * La cámara se enciende SOLO al llegar al paso del rostro.
   *
   * Tener el piloto encendido mientras se teclea un nombre es una
   * cámara grabando sin motivo en una pantalla de administración.
   */
  useEffect(() => {
    if (step !== 'rostro') {
      camera.stop();
      return;
    }
    void camera.start();
    return () => camera.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Libera la URL del objeto para no filtrar memoria al repetir tomas.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  // ── Acciones ────────────────────────────────────────────────────

  const submitDatos = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (fullName.trim().length < 2) {
      setError('El nombre debe tener al menos 2 caracteres');
      return;
    }

    setBusy(true);
    try {
      const created = await api.createPerson({
        fullName: fullName.trim(),
        externalId: externalId.trim() || undefined,
      });
      setPerson(created);
      setDirty(true);
      setStep('rol');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'No se pudo crear la persona',
      );
    } finally {
      setBusy(false);
    }
  };

  const submitRol = async () => {
    if (!person || !selectedRoleId) return;
    setError(null);
    setBusy(true);
    try {
      await api.assignRole(person.id, selectedRoleId);
      setDirty(true);
      setStep('rostro');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'No se pudo asignar el rol',
      );
    } finally {
      setBusy(false);
    }
  };

  const capture = async () => {
    setError(null);
    // Para enrolar se usa más resolución que en la autenticación: es una
    // sola imagen y su calidad condiciona todos los reconocimientos
    // futuros de esta persona.
    const blob = await camera.captureFrame(960, 0.9);
    if (!blob) {
      setError('No se pudo capturar la imagen');
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setCaptured(blob);
    setPreview(URL.createObjectURL(blob));
  };

  const retake = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setCaptured(null);
    setError(null);
  };

  const submitRostro = async () => {
    if (!person || !captured) return;
    setBusy(true);
    setError(null);

    try {
      const result = await api.enrollFace(person.id, captured);
      setEnrolled(true);
      setDirty(true);
      toast.success(
        `Rostro registrado (calidad ${Math.round(result.detectionScore * 100)}%)`,
      );
      setTimeout(onFinished, 900);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo registrar el rostro',
      );
    } finally {
      setBusy(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────

  const currentIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <GlassCard className="animate-fade-up w-full max-w-lg overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div className="min-w-0">
            <h2 id="onboarding-title" className="font-semibold text-white">
              {existing ? 'Completar el alta' : 'Registrar persona'}
            </h2>
            <p className="truncate text-xs text-white/45">
              {person ? person.fullName : 'Datos, rol y rostro'}
            </p>
          </div>
          <button
            onClick={close}
            aria-label="Cerrar"
            className="rounded-lg p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Indicador de pasos ──────────────────────────────── */}
        <ol className="flex items-center gap-2 border-b border-white/10 px-5 py-3">
          {STEPS.map((s, index) => {
            const done = index < currentIndex || (s.id === 'rostro' && enrolled);
            const active = s.id === step;
            return (
              <li key={s.id} className="flex flex-1 items-center gap-2">
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                    done && 'bg-vault-green/20 text-vault-green',
                    active && !done && 'bg-vault-blue text-white',
                    !done && !active && 'bg-white/10 text-white/40',
                  )}
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
                </span>
                <span
                  className={cn(
                    'text-xs font-medium',
                    active ? 'text-white' : 'text-white/40',
                  )}
                >
                  {s.label}
                </span>
                {index < STEPS.length - 1 && (
                  <span className="h-px flex-1 bg-white/10" />
                )}
              </li>
            );
          })}
        </ol>

        {/* ── Paso 1: datos ───────────────────────────────────── */}
        {step === 'datos' && (
          <form onSubmit={submitDatos} className="space-y-4 px-5 py-5">
            <GlassField
              accent="purple"
              icon={<User className="h-4 w-4" />}
              label="Nombre completo"
              name="fullName"
              placeholder="Diego Ossa"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              autoComplete="off"
              autoFocus
            />
            <GlassField
              accent="orange"
              icon={<IdCard className="h-4 w-4" />}
              label="Identificador (opcional)"
              name="externalId"
              placeholder="Cédula o código"
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              autoComplete="off"
            />
            <div className="flex justify-end">
              <VaultButton type="submit" size="sm" loading={busy}>
                Continuar
              </VaultButton>
            </div>
          </form>
        )}

        {/* ── Paso 2: rol ─────────────────────────────────────── */}
        {step === 'rol' && (
          <div className="space-y-3 px-5 py-5">
            <p className="text-xs text-white/45">
              Sin rol, el sistema reconoce a la persona y no la deja pasar por
              ninguna puerta.
            </p>

            {roles === null ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-16 animate-pulse rounded-xl bg-white/5"
                  />
                ))}
              </div>
            ) : roles.length === 0 ? (
              <p className="rounded-xl border border-denied/20 bg-denied/10 px-4 py-3 text-sm text-denied">
                No hay ningún rol activo definido. Créalos antes de dar de alta
                a nadie.
              </p>
            ) : (
              <div
                role="radiogroup"
                aria-label="Rol a asignar"
                className="space-y-2"
              >
                {roles.map((role) => {
                  const selected = selectedRoleId === role.id;
                  return (
                    <button
                      key={role.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setSelectedRoleId(role.id)}
                      className={cn(
                        'w-full rounded-xl border px-4 py-3 text-left transition-all',
                        selected
                          ? 'border-vault-blue bg-vault-blue/10 shadow-[0_0_0_1px_var(--color-vault-blue)]'
                          : 'border-white/10 bg-white/[0.04] hover:border-white/25',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <ShieldCheck
                          className={cn(
                            'h-4 w-4 shrink-0',
                            selected ? 'text-vault-blue' : 'text-white/35',
                          )}
                        />
                        <span className="font-medium text-white">
                          {role.name}
                        </span>
                      </div>
                      {role.description && (
                        <p className="mt-1 pl-6 text-xs text-white/45">
                          {role.description}
                        </p>
                      )}
                      {/* Lo que de verdad decide si alguien pasa no es el
                          nombre del rol, son sus permisos. Mostrarlos aquí
                          evita elegir a ciegas. */}
                      {role.permissions.length > 0 && (
                        <p className="mt-1.5 pl-6 text-[11px] text-white/35">
                          {role.permissions
                            .map((p) => `${p.zone} · ${p.schedule}`)
                            .join('   |   ')}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex justify-end">
              <VaultButton
                size="sm"
                loading={busy}
                disabled={!selectedRoleId}
                onClick={() => void submitRol()}
              >
                Asignar y continuar
              </VaultButton>
            </div>
          </div>
        )}

        {/* ── Paso 3: rostro ──────────────────────────────────── */}
        {step === 'rostro' && (
          <>
            <div className="relative aspect-video bg-black">
              {preview ? (
                <img
                  src={preview}
                  alt="Captura para revisar"
                  className="h-full w-full -scale-x-100 object-cover"
                />
              ) : (
                <>
                  <video
                    ref={camera.videoRef}
                    playsInline
                    muted
                    autoPlay
                    className="h-full w-full -scale-x-100 object-cover"
                  />
                  {camera.isReady && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <div className="h-56 w-44 rounded-[50%] border-2 border-dashed border-white/30" />
                    </div>
                  )}
                </>
              )}

              {!camera.isReady && !preview && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
                  <Camera className="h-9 w-9 animate-pulse text-white/50" />
                  <p className="text-sm text-white/60">
                    {camera.error ?? 'Iniciando cámara...'}
                  </p>
                </div>
              )}

              {enrolled && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-vault-green/25 backdrop-blur-sm">
                  <CheckCircle2 className="h-14 w-14 text-white" />
                  <p className="font-semibold text-white">Alta completada</p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-4">
              <p className="text-xs text-white/40">
                Mira de frente, con buena luz y sin gafas de sol.
              </p>
              <div className="flex gap-2">
                {preview ? (
                  <>
                    <VaultButton size="sm" tone="ghost" onClick={retake}>
                      Repetir
                    </VaultButton>
                    <VaultButton
                      size="sm"
                      loading={busy}
                      onClick={() => void submitRostro()}
                    >
                      Registrar
                    </VaultButton>
                  </>
                ) : (
                  <VaultButton
                    size="sm"
                    disabled={!camera.isReady}
                    onClick={() => void capture()}
                    icon={<Camera className="h-4 w-4" />}
                  >
                    Capturar
                  </VaultButton>
                )}
              </div>
            </div>
          </>
        )}

        {error && (
          <div className="flex items-start gap-2 border-t border-denied/20 bg-denied/10 px-5 py-3 text-sm text-denied">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* La fotografía NUNCA se almacena: el servidor extrae el vector y
            la descarta. Decirlo en la propia pantalla del alta es donde
            de verdad importa, porque es quien opera quien lo explica a
            quien está delante de la cámara. */}
        <p className="border-t border-white/10 px-5 py-3 text-[11px] leading-relaxed text-white/35">
          No se guarda ninguna fotografía: el servidor extrae la representación
          matemática del rostro y descarta la imagen.
        </p>
      </GlassCard>
    </div>
  );
}
