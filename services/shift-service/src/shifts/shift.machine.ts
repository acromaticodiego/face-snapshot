/**
 * Máquina de estados de la jornada laboral.
 *
 * Función pura, sin base de datos y sin reloj propio, por el mismo
 * motivo que el motor de política del Access Service: de aquí salen
 * las horas que se le pagan a alguien, y eso hay que poder probarlo
 * exhaustivamente sin levantar nada.
 *
 * LOS CUATRO ESTADOS
 * ──────────────────
 *   FUERA        no hay jornada abierta
 *   EN_TURNO     dentro y trabajando; el tiempo computa
 *   EN_DESCANSO  en una zona de descanso; sigue en la sede, no computa
 *   EN_PAUSA     salió de la sede con la jornada abierta; provisional
 *
 * EL PROBLEMA DE NO PODER VER EL FUTURO
 * ─────────────────────────────────────
 * Cuando alguien sale, el sistema no sabe si va a volver en diez
 * minutos o si se ha ido a casa. Adivinar es lo que hacen mal casi
 * todos estos sistemas: o cierran la jornada en cuanto sales —y
 * quien baja a por un café aparece con dos jornadas— o no la cierran
 * nunca —y quien se va a casa acumula horas mientras duerme—.
 *
 * Aquí no se adivina. Salir abre una PAUSA, que es un estado
 * declaradamente provisional, y el tiempo decide: si vuelve, la pausa
 * se cierra y la jornada continúa; si no vuelve, el reconciliador la
 * convierte en el cierre de la jornada **con la hora de inicio de la
 * pausa**, no con la del momento en que se dio cuenta. Así la hoja de
 * horas acaba siendo correcta a posteriori sin pedirle a nadie que
 * declare nada.
 *
 * POR QUE HACE FALTA `stillInsideSite`
 * ────────────────────────────────────
 * Salir de una zona no es lo mismo que salir del edificio. Quien sale
 * del laboratorio y sigue en las oficinas no está de pausa: vuelve a
 * estar en turno. Ese dato lo aporta el Access Service, que es quien
 * lleva la presencia, y viaja en el evento para no tener que
 * preguntárselo de vuelta.
 */

export type ShiftState = 'FUERA' | 'EN_TURNO' | 'EN_DESCANSO' | 'EN_PAUSA';
export type ShiftEffect = 'WORK' | 'BREAK' | 'NEUTRAL';
export type Passage = 'IN' | 'OUT';

/** Estado actual de la jornada abierta, o `null` si no hay ninguna. */
export interface ShiftSnapshot {
  state: ShiftState;
  /** Desde cuándo está en ese estado. */
  stateSince: Date;
  /**
   * Último movimiento del que hay constancia, cambiara o no el estado.
   *
   * Se distingue de `stateSince` porque hay pasos que se registran sin
   * cambiar el estado —salir del laboratorio y seguir en la oficina—
   * y son la mejor prueba de hasta cuándo estuvo alguien allí. Es lo
   * que se usa para cerrar una jornada olvidada.
   */
  lastSeenAt: Date;
  workedSeconds: number;
  breakSeconds: number;
}

export interface PassageInput {
  direction: Passage;
  zoneShiftEffect: ShiftEffect;
  /**
   * Si tras este paso la persona sigue dentro de alguna zona de la
   * sede. Lo calcula el Access Service, que es quien tiene la
   * presencia, y viaja en el evento.
   */
  stillInsideSite: boolean;
  at: Date;
}

export type ShiftDecision =
  /** No había jornada y este paso la abre. */
  | { action: 'OPEN'; state: ShiftState }
  /** Hay jornada y este paso la mueve (o la deja igual y suma tiempo). */
  | {
      action: 'UPDATE';
      state: ShiftState;
      /** Segundos a sumar al tramo trabajado. */
      workedDelta: number;
      /** Segundos a sumar al tramo de descanso. */
      breakDelta: number;
    }
  /**
   * El paso se anota en la línea de tiempo pero no cambia nada: entrar
   * al parking no es fichar, y salir sin jornada abierta tampoco es
   * nada que contabilizar.
   */
  | { action: 'RECORD_ONLY' }
  /** El evento llegó desordenado y se descarta. */
  | { action: 'IGNORE'; reason: 'OUT_OF_ORDER' };

/** Los segundos completos transcurridos entre dos instantes. */
function secondsBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
}

/**
 * Reparte el tiempo del estado que se abandona.
 *
 * Solo EN_TURNO computa como trabajado. EN_DESCANSO y EN_PAUSA suman
 * al descanso, y estando FUERA no hay nada que sumar. Esta tabla es
 * toda la política de cómputo del sistema; concentrarla en un sitio
 * es lo que permite cambiarla sin ir a buscar condicionales sueltos.
 */
function accrue(
  state: ShiftState,
  seconds: number,
): { workedDelta: number; breakDelta: number } {
  switch (state) {
    case 'EN_TURNO':
      return { workedDelta: seconds, breakDelta: 0 };
    case 'EN_DESCANSO':
    case 'EN_PAUSA':
      return { workedDelta: 0, breakDelta: seconds };
    case 'FUERA':
      return { workedDelta: 0, breakDelta: 0 };
  }
}

/** A qué estado lleva un paso, sin mirar el tiempo. */
function nextState(current: ShiftState, passage: PassageInput): ShiftState {
  if (passage.direction === 'IN') {
    // Entrar a una zona te pone en el modo de esa zona. Una zona
    // neutra —un parking, un pasillo— no cambia nada a propósito: no
    // es ni trabajo ni descanso, y tratarla como cualquiera de los dos
    // sería inventarse un dato.
    if (passage.zoneShiftEffect === 'WORK') return 'EN_TURNO';
    if (passage.zoneShiftEffect === 'BREAK') return 'EN_DESCANSO';
    return current;
  }

  // Salir de una zona sin salir de la sede es volver al trabajo: es el
  // caso de quien sale del laboratorio o de la cafetería.
  if (passage.stillInsideSite) return 'EN_TURNO';

  // Salir de la sede con la jornada abierta abre una pausa provisional.
  return 'EN_PAUSA';
}

export function applyPassage(
  snapshot: ShiftSnapshot | null,
  passage: PassageInput,
): ShiftDecision {
  // ── Sin jornada abierta ───────────────────────────────────────
  if (!snapshot) {
    if (passage.direction === 'OUT') {
      // Una salida sin jornada abierta es lo que produce el
      // anti-passback blando el día que se estrena el sistema: nadie
      // ha "entrado" todavía. Se deja constancia del movimiento y no
      // se inventa una jornada hacia atrás.
      return { action: 'RECORD_ONLY' };
    }

    if (passage.zoneShiftEffect === 'NEUTRAL') {
      // Entrar al parking no es empezar a trabajar.
      return { action: 'RECORD_ONLY' };
    }

    return {
      action: 'OPEN',
      state: passage.zoneShiftEffect === 'BREAK' ? 'EN_DESCANSO' : 'EN_TURNO',
    };
  }

  // ── Eventos desordenados ──────────────────────────────────────
  //
  // El bus entrega en orden mientras haya un solo consumidor, pero un
  // reintento o un reproceso pueden traer algo anterior al estado
  // actual. Aplicarlo restaría tiempo o movería la jornada hacia
  // atrás, así que se descarta: la línea de tiempo prefiere un hueco
  // a un dato falso.
  if (passage.at < snapshot.stateSince) {
    return { action: 'IGNORE', reason: 'OUT_OF_ORDER' };
  }

  const target = nextState(snapshot.state, passage);
  const elapsed = secondsBetween(snapshot.stateSince, passage.at);

  if (target === snapshot.state) {
    // Ni el estado cambia ni hay tramo que cerrar: el tiempo se sigue
    // acumulando en el mismo estado y se contará en la transición que
    // sí llegue. Solo queda el rastro en la línea de tiempo.
    return { action: 'RECORD_ONLY' };
  }

  // Nótese que ningún paso cierra una jornada, ni siquiera una salida:
  // salir abre una pausa. El cierre lo decide el reconciliador, cuando
  // queda claro que la persona no va a volver.
  return {
    action: 'UPDATE',
    state: target,
    ...accrue(snapshot.state, elapsed),
  };
}

/**
 * ¿Ha durado ya bastante la pausa como para darla por final de
 * jornada?
 *
 * La devuelve el reconciliador, no un paso por una puerta, porque lo
 * que la dispara es justamente que NO haya pasado nada.
 */
export function resolvePause(
  snapshot: ShiftSnapshot,
  now: Date,
  pauseTimeoutSeconds: number,
): { endedAt: Date } | null {
  if (snapshot.state !== 'EN_PAUSA') return null;
  if (secondsBetween(snapshot.stateSince, now) < pauseTimeoutSeconds) {
    return null;
  }

  // La jornada termina cuando la persona SALIO, no cuando el
  // reconciliador se dio cuenta. Y el tiempo de la pausa no se suma a
  // ningún sitio: nunca fue un descanso, fue el final del día.
  return { endedAt: snapshot.stateSince };
}

/**
 * ¿Lleva esta jornada abierta más de lo que dura ningún turno?
 *
 * Es el caso de quien se va sin fichar la salida por una puerta sin
 * lector. Sin este cierre, la hoja de horas mostraría jornadas de tres
 * días y las estadísticas dejarían de significar nada. Se cierra a la
 * hora del último movimiento conocido —no a la de ahora— y se marca
 * como cerrada por el sistema, para que quien la revise sepa que ese
 * final es una estimación y no un fichaje.
 */
export function resolveStale(
  snapshot: ShiftSnapshot,
  now: Date,
  maxShiftSeconds: number,
): { endedAt: Date; workedDelta: number; breakDelta: number } | null {
  if (snapshot.state === 'FUERA') return null;
  if (secondsBetween(snapshot.lastSeenAt, now) < maxShiftSeconds) return null;

  // Se cierra en el último movimiento del que hay constancia, y se
  // computa el tramo hasta ahí: esa parte sí está evidenciada. Lo que
  // no se cuenta es el hueco entre ese último movimiento y ahora, que
  // es precisamente el que nadie puede afirmar que se trabajara.
  return {
    endedAt: snapshot.lastSeenAt,
    ...accrue(
      snapshot.state,
      secondsBetween(snapshot.stateSince, snapshot.lastSeenAt),
    ),
  };
}

/**
 * Día al que se imputa una jornada, en la hora local de la sede.
 *
 * `Intl.DateTimeFormat` con `timeZone` hace la conversión correcta,
 * cambios de horario de verano incluidos, sin dependencias. Usar
 * `getDate()` tomaría la zona del servidor, que en un contenedor es
 * UTC: en Bogotá (UTC-5), todo lo fichado después de las 19:00 se
 * imputaría al día siguiente.
 */
export function businessDateOf(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);

  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';

  const date = `${value('year')}-${value('month')}-${value('day')}`;
  if (date.length !== 10) {
    throw new Error(`Zona horaria no reconocida: ${timezone}`);
  }
  return date;
}

// ═══════════════════════════════════════════════════════════════════
//  Cambios declarados por la persona
// ═══════════════════════════════════════════════════════════════════

/**
 * POR QUE HACEN FALTA SI YA ESTAN LAS PUERTAS
 * ───────────────────────────────────────────
 * Porque no todo descanso pasa por un lector. Ir al baño, bajar a por
 * un café o quedarse comiendo en el propio puesto no cruzan ninguna
 * puerta, y sin embargo son interrupciones reales de la jornada. Si el
 * único modo de registrarlas fuera pasar por una zona marcada como de
 * descanso, la hoja de horas contaría como trabajado todo lo que
 * ocurriera dentro del edificio.
 *
 * ESTO NO ROMPE LA SEPARACION ENTRE LOS DOS DOMINIOS
 * ──────────────────────────────────────────────────
 * Al contrario: la confirma. Declarar un descanso NO abre ninguna
 * puerta y no toca la presencia física, que sigue diciendo la verdad
 * —la persona continúa dentro de su zona—. Solo cambia la
 * interpretación laboral, que es justo lo que este servicio posee.
 *
 * QUE NO SE PUEDE DECLARAR
 * ────────────────────────
 * Ni entrar ni salir. Eso lo decide el Access Service con una cara
 * delante de una cámara, y un botón que permitiera fichar la entrada
 * convertiría todo el control de acceso en un adorno.
 */

export type ManualAction = 'START_BREAK' | 'END_BREAK';

export type ManualRejection =
  /** No hay jornada abierta: hay que entrar por una puerta primero. */
  | 'NO_OPEN_DAY'
  | 'ALREADY_ON_BREAK'
  | 'NOT_ON_BREAK'
  /** Está fuera de la sede; su vuelta la registra la puerta. */
  | 'OUTSIDE_SITE';

export type ManualDecision =
  | {
      action: 'UPDATE';
      state: ShiftState;
      workedDelta: number;
      breakDelta: number;
    }
  | { action: 'REJECT'; reason: ManualRejection };

export function applyManualChange(
  snapshot: ShiftSnapshot | null,
  change: ManualAction,
  at: Date,
): ManualDecision {
  if (!snapshot) return { action: 'REJECT', reason: 'NO_OPEN_DAY' };

  // Quien está de pausa salió del edificio: su vuelta la registra la
  // puerta, no un botón. Dejarle "terminar el descanso" desde el móvil
  // sería dejarle fichar sin estar.
  if (snapshot.state === 'EN_PAUSA') {
    return { action: 'REJECT', reason: 'OUTSIDE_SITE' };
  }

  // Sin jornada viva no hay estado que cambiar. `FUERA` con instantánea
  // solo puede venir de una jornada ya cerrada.
  if (snapshot.state === 'FUERA') {
    return { action: 'REJECT', reason: 'NO_OPEN_DAY' };
  }

  const elapsed = secondsBetween(snapshot.stateSince, at);

  if (change === 'START_BREAK') {
    if (snapshot.state === 'EN_DESCANSO') {
      return { action: 'REJECT', reason: 'ALREADY_ON_BREAK' };
    }
    return {
      action: 'UPDATE',
      state: 'EN_DESCANSO',
      ...accrue(snapshot.state, elapsed),
    };
  }

  if (snapshot.state !== 'EN_DESCANSO') {
    return { action: 'REJECT', reason: 'NOT_ON_BREAK' };
  }

  return {
    action: 'UPDATE',
    state: 'EN_TURNO',
    ...accrue(snapshot.state, elapsed),
  };
}
