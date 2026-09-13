/**
 * Convierte las respuestas del Gateway en texto legible.
 *
 * POR QUE TEXTO Y NO EL JSON TAL CUAL
 * ───────────────────────────────────
 * Devolver el JSON crudo es lo fácil y es peor. Quien consume esto es
 * un modelo de lenguaje que después se lo cuenta a una persona, y un
 * volcado de identificadores le obliga a inventarse el significado de
 * cada campo. Un texto que ya dice «21 personas dentro, todas en
 * Oficinas» se resume bien; una lista de UUID, no.
 *
 * LOS IDENTIFICADORES NO SALEN, LOS NOMBRES SI
 * ────────────────────────────────────────────
 * No aportan nada a quien lee y ocupan sitio. Solo se conservan donde
 * sirven para pedir otra cosa después, como el identificador de un
 * parte de relevo.
 *
 * ESTAS FUNCIONES SON PURAS
 * ─────────────────────────
 * Sin red y sin estado, para poder probarlas sin levantar nada. Es
 * donde vive casi toda la lógica de este servidor.
 */

export interface PresenceResponse {
  items: Array<{
    personId: string;
    zoneName: string;
    zoneShiftEffect: string;
    lastDirection: string;
    lastPassageAt: string;
  }>;
  occupancyByZone: Record<string, { zoneName: string; count: number }>;
  totalPeople: number;
}

export interface ShiftsResponse {
  items: Array<{
    personId: string;
    personName: string;
    state: string;
    since: string;
    startedAt: string;
    siteName: string | null;
    workedSeconds?: number;
    breakSeconds?: number;
  }>;
  countsByState: Record<string, number>;
}

export interface PendingResponse {
  items: Array<{
    title: string;
    category: string;
    severity: string;
    mentionedTime: string | null;
    quote: string | null;
    quoteVerified: boolean;
    origin: string;
    entry: {
      id: string;
      personName: string;
      siteName: string | null;
      businessDate: string;
      coversTo: string;
    };
  }>;
  total: number;
  sinceDays: number;
}

export interface HandoversResponse {
  items: Array<{
    id: string;
    personName: string;
    siteName: string | null;
    businessDate: string;
    coversFrom: string;
    coversTo: string;
    source: string;
    summary: string;
    incidents: Array<{ title: string; category: string; severity: string }>;
    accessSnapshot: {
      totals?: { attempts: number; granted: number; denied: number };
      byReason?: Array<{ reason: string; count: number }>;
    } | null;
  }>;
  total: number;
}

/** Una fecha ISO en algo que se lee. Devuelve la cadena tal cual si no lo es. */
export function hora(iso: string | null | undefined): string {
  if (!iso) return 'sin hora';
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return iso;
  return fecha.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** Segundos a «7 h 12 min». */
export function duracion(segundos: number | undefined): string {
  if (!segundos || segundos < 0) return '0 min';
  const horas = Math.floor(segundos / 3600);
  const minutos = Math.round((segundos % 3600) / 60);
  if (horas === 0) return `${minutos} min`;
  return `${horas} h ${minutos} min`;
}

export function formatPresence(
  presencia: PresenceResponse,
  turnos: ShiftsResponse | null,
): string {
  if (presencia.totalPeople === 0) {
    return 'No consta nadie dentro ahora mismo.';
  }

  const nombres = new Map(
    (turnos?.items ?? []).map((t) => [t.personId, t.personName]),
  );

  const lineas: string[] = [
    `${presencia.totalPeople} persona(s) dentro ahora mismo.`,
    '',
    'Por zona:',
  ];

  for (const zona of Object.values(presencia.occupancyByZone)) {
    lineas.push(`  · ${zona.zoneName}: ${zona.count}`);
  }

  lineas.push('', 'Quién, y desde cuándo:');
  for (const persona of presencia.items.slice(0, 40)) {
    const nombre = nombres.get(persona.personId) ?? 'sin jornada abierta';
    lineas.push(
      `  · ${nombre} — ${persona.zoneName}, desde ${hora(persona.lastPassageAt)}`,
    );
  }
  if (presencia.items.length > 40) {
    lineas.push(`  … y ${presencia.items.length - 40} más`);
  }

  // Esta aclaración NO es adorno: presencia y jornada son dos preguntas
  // distintas en este sistema (ADR 0007), y un modelo que las mezcle
  // dirá que alguien está dentro cuando solo tiene la jornada abierta.
  lineas.push(
    '',
    'Nota: «dentro» es presencia física registrada por las puertas. Alguien ' +
      'con la jornada abierta puede estar fuera del edificio (estado EN_PAUSA), ' +
      'y no aparece aquí.',
  );

  return lineas.join('\n');
}

export function formatShifts(turnos: ShiftsResponse): string {
  if (turnos.items.length === 0) return 'No hay ninguna jornada abierta.';

  const lineas: string[] = ['Jornadas abiertas:', ''];

  for (const [estado, cuantas] of Object.entries(turnos.countsByState)) {
    lineas.push(`  ${estado}: ${cuantas}`);
  }

  lineas.push('', 'Detalle:');
  for (const t of turnos.items.slice(0, 40)) {
    const trabajado =
      t.workedSeconds === undefined ? '' : ` · trabajado ${duracion(t.workedSeconds)}`;
    lineas.push(
      `  · ${t.personName} — ${t.state} desde ${hora(t.since)}` +
        ` (entró ${hora(t.startedAt)})${trabajado}`,
    );
  }
  if (turnos.items.length > 40) {
    lineas.push(`  … y ${turnos.items.length - 40} más`);
  }

  return lineas.join('\n');
}

export function formatPending(pendientes: PendingResponse): string {
  if (pendientes.total === 0) {
    return `No queda ninguna incidencia sin cerrar en los últimos ${pendientes.sinceDays} días.`;
  }

  const lineas: string[] = [
    `${pendientes.total} incidencia(s) sin cerrar en los últimos ${pendientes.sinceDays} días:`,
    '',
  ];

  for (const i of pendientes.items) {
    lineas.push(`  · [${i.category}/${i.severity}] ${i.title}`);
    lineas.push(
      `      lo dejó ${i.entry.personName}, turno del ${i.entry.businessDate.slice(0, 10)}` +
        (i.mentionedTime ? ` (${i.mentionedTime})` : ''),
    );
    if (i.quote) {
      // Se marca lo que el modelo propuso sin poder señalar dónde lo
      // leyó. Quien lea esto tiene que poder distinguirlo.
      const respaldo = i.quoteVerified ? '' : '  [CITA NO RESPALDADA]';
      lineas.push(`      «${i.quote}»${respaldo}`);
    }
  }

  return lineas.join('\n');
}

export function formatHandovers(partes: HandoversResponse): string {
  if (partes.items.length === 0) return 'No hay partes de relevo en ese periodo.';

  const lineas: string[] = [`${partes.total} parte(s) de relevo:`, ''];

  for (const p of partes.items) {
    lineas.push(
      `── ${p.businessDate.slice(0, 10)} · ${p.personName}` +
        (p.siteName ? ` · ${p.siteName}` : '') +
        ` · ${p.source.toLowerCase()}`,
    );
    lineas.push(`   cubre ${hora(p.coversFrom)} → ${hora(p.coversTo)}`);
    lineas.push(`   ${p.summary}`);

    if (p.incidents.length > 0) {
      lineas.push(`   incidencias (${p.incidents.length}):`);
      for (const i of p.incidents) {
        lineas.push(`     · [${i.category}/${i.severity}] ${i.title}`);
      }
    }

    const totales = p.accessSnapshot?.totals;
    if (totales) {
      const motivos = (p.accessSnapshot?.byReason ?? [])
        .slice(0, 3)
        .map((m) => `${m.reason} ${m.count}`)
        .join(', ');
      lineas.push(
        `   las puertas en esa franja: ${totales.attempts} intentos, ` +
          `${totales.granted} concedidos, ${totales.denied} denegados` +
          (motivos ? ` (${motivos})` : ''),
      );
    } else {
      lineas.push('   sin cruce de accesos: el Access Service no respondió al firmar');
    }

    lineas.push(`   id del parte: ${p.id}`);
    lineas.push('');
  }

  return lineas.join('\n').trimEnd();
}
