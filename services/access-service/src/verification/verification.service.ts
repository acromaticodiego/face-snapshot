import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import type { JwtSignOptions } from '@nestjs/jwt';

import { AccessLogsService, parseTtlMs } from '../logs/access-logs.service';
import { FaceClient, IdentifiedFace } from '../face/face.client';
import { PolicyService } from '../policy/policy.service';
import type { AccessPointContext } from '../policy/policy.repository';
import type { Passage } from '../presence/antipassback.engine';
import { PassageService } from '../presence/passage.service';
import { DomainMetrics } from '../telemetry/domain.metrics';
import { judgeFrame, type LivenessPolicy } from './liveness.engine';
import { PresenceService } from '../presence/presence.service';
import {
  VOTE_WINDOW_STORE,
  type VoteWindowStore,
} from './vote-window.store';

export type AccessReason =
  | 'GRANTED'
  | 'BELOW_THRESHOLD'
  | 'NO_FACE_DETECTED'
  | 'MULTIPLE_FACES'
  | 'LOW_QUALITY'
  | 'INSUFFICIENT_VOTES'
  | 'PERSON_SUSPENDED'
  // Autorizacion: la persona SI fue reconocida, pero no puede pasar.
  | 'NO_ROLE_ASSIGNED'
  | 'NO_PERMISSION_FOR_ZONE'
  | 'OUTSIDE_SCHEDULE'
  | 'ASSIGNMENT_EXPIRED'
  | 'ACCESS_POINT_DISABLED'
  // Suplantacion: la captura no parece una persona delante de la
  // camara, sino una foto o una pantalla. Solo se emite en modo HARD.
  | 'LIVENESS_FAILED'
  // Anti-passback: te reconozco y puedes pasar, pero ya constas dentro.
  | 'ANTIPASSBACK_VIOLATION';

export interface FaceVerdict {
  bbox: { x: number; y: number; width: number; height: number };
  recognized: boolean;
  personName: string | null;
  personId: string | null;
  confidence: number;
}

export interface VerifyFrameResult {
  authenticated: boolean;
  person: { id: string; name: string } | null;
  confidence: number;
  bbox: FaceVerdict['bbox'] | null;
  faces: FaceVerdict[];
  imageWidth: number;
  imageHeight: number;
  reason: AccessReason;
  sessionKey: string;
  votes: { current: number; required: number };
  accessToken?: string;
  /** Contexto del terminal, para que la interfaz sepa dónde está. */
  location?: { site: string; zone: string; accessPoint: string };
  /**
   * Sentido del paso concedido.
   *
   * Solo presente cuando se concede. La pantalla de bienvenida lo
   * necesita para no saludar con un "buenos días" a quien acaba de
   * fichar la salida.
   */
  passage?: Passage;
}

/**
 * Anomalia que corresponde a cada desenlace del anti-passback.
 *
 * Se define como tabla y no con condicionales para que quede a la
 * vista que hay exactamente cuatro desenlaces y que solo dos dejan
 * rastro de anomalia. `DENY` no aparece porque no llega hasta aqui:
 * se resuelve antes de conceder nada.
 */
const ANOMALY_BY_OUTCOME = {
  ALLOW: null,
  ALLOW_SOFT: 'ANTIPASSBACK_SOFT',
  ALLOW_REPEAT: 'DUPLICATE_PASSAGE',
} as const satisfies Record<
  'ALLOW' | 'ALLOW_SOFT' | 'ALLOW_REPEAT',
  'ANTIPASSBACK_SOFT' | 'DUPLICATE_PASSAGE' | null
>;

/**
 * Decide si se concede el acceso.
 *
 * ESTA ES LA UNICA AUTORIDAD DEL SISTEMA EN ESA DECISION. El frontend
 * se limita a pintar el resultado: aunque alguien manipulase el
 * JavaScript del navegador, no podría concederse acceso, porque el
 * token de sesión solo lo emite este servicio tras superar la votación.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);
  /**
   * Duración del token de sesión.
   *
   * `jsonwebtoken` tipa `expiresIn` como un literal de plantilla
   * (`'15m'`, `'2h'`...), no como un `string` cualquiera. El valor llega
   * de una variable de entorno, así que se estrecha el tipo aquí, en un
   * único punto, en lugar de repetir el cast en cada firma.
   */
  private readonly sessionTtl: NonNullable<JwtSignOptions['expiresIn']>;

  /**
   * Politica de deteccion de vida.
   *
   * El modo por defecto es SOFT -anota y deja pasar- porque la senal no
   * esta validada contra ataques reales. Encender HARD sin haber mirado
   * antes lo que SOFT registra es denegar accesos a ciegas.
   */
  private readonly liveness: LivenessPolicy;

  constructor(
    private readonly faceClient: FaceClient,
    @Inject(VOTE_WINDOW_STORE)
    private readonly votes: VoteWindowStore,
    private readonly logs: AccessLogsService,
    private readonly policy: PolicyService,
    private readonly presence: PresenceService,
    private readonly passages: PassageService,
    private readonly jwt: JwtService,
    private readonly metrics: DomainMetrics,
    config: ConfigService,
  ) {
    this.sessionTtl = config.get<string>(
      'JWT_EXPIRES_IN',
      '15m',
    ) as NonNullable<JwtSignOptions['expiresIn']>;

    this.liveness = {
      mode: config.get<LivenessPolicy['mode']>('LIVENESS_MODE', 'SOFT'),
      // Los umbrales salen de medir degradaciones SINTETICAS sobre un
      // rostro: captura directa 0.56 de detalle y 14 de pico; una foto
      // de una foto 0.32 y 38; una pantalla 0.63 y 149. Estan puestos
      // en medio de esos valores y son PROVISIONALES hasta medirlos
      // con ataques reales. Por eso el modo por defecto no deniega.
      minDetailRatio: Number(config.get('LIVENESS_MIN_DETAIL_RATIO', 0.25)),
      maxPatternPeak: Number(config.get('LIVENESS_MAX_PATTERN_PEAK', 90)),
    };
  }

  async verifyFrame(params: {
    image: Buffer;
    filename: string;
    mimetype: string;
    sessionKey?: string;
    cameraId: string;
    terminalKey: string;
  }): Promise<VerifyFrameResult> {
    // El terminal se resuelve ANTES de mirar la imagen. Una clave
    // desconocida no debe poder abrir nada, ni siquiera con un rostro
    // perfectamente registrado: es la puerta la que tiene que ser
    // legítima, no solo la cara.
    const point = await this.policy.resolveAccessPoint(params.terminalKey);
    if (!point) {
      this.logger.warn(`Terminal desconocido: ${params.terminalKey}`);
      return {
        authenticated: false,
        person: null,
        confidence: 0,
        bbox: null,
        faces: [],
        imageWidth: 0,
        imageHeight: 0,
        reason: 'ACCESS_POINT_DISABLED',
        sessionKey: params.sessionKey ?? this.votes.createKey(),
        votes: { current: 0, required: 0 },
      };
    }

    const recognition = await this.faceClient.identify(
      params.image,
      params.filename,
      params.mimetype,
    );

    // ── Caso 1: no hay ningún rostro ──────────────────────────────
    if (recognition.faces.length === 0) {
      return this.deny({
        reason: 'NO_FACE_DETECTED',
        sessionKey: params.sessionKey ?? this.votes.createKey(),
        faces: [],
        imageWidth: recognition.imageWidth,
        imageHeight: recognition.imageHeight,
        cameraId: params.cameraId,
        point,
        // Un frame sin rostro no se audita: la cámara genera cinco por
        // segundo y llenaría la tabla de ruido sin valor forense.
        skipLog: true,
      });
    }

    // ── Caso 2: varias personas en el encuadre ────────────────────
    // Se rechaza a propósito. Con dos rostros no se puede saber quién
    // pretende entrar, y es el escenario clásico de "colarse" detrás de
    // alguien autorizado.
    if (recognition.faces.length > 1) {
      return this.deny({
        reason: 'MULTIPLE_FACES',
        sessionKey: params.sessionKey ?? this.votes.createKey(),
        faces: recognition.faces.map((f) => this.toVerdict(f)),
        imageWidth: recognition.imageWidth,
        imageHeight: recognition.imageHeight,
        cameraId: params.cameraId,
        point,
      });
    }

    const face = recognition.faces[0];
    const verdict = this.toVerdict(face);

    // ── Caso 3: la captura no parece una persona ──────────────────
    //
    // Va ANTES de votar, y eso es lo que hace que no haga falta ningún
    // mecanismo nuevo: un frame sospechoso no acumula voto, igual que
    // uno de baja calidad. Como entrar exige 3 coincidencias dentro de
    // una ventana de 5, un reflejo aislado no cierra la puerta pero una
    // fuente consistentemente sospechosa nunca llega a los 3 votos.
    //
    // En SOFT se anota y se sigue. Es el modo por defecto a propósito:
    // la señal no está validada contra ataques reales, y denegar el
    // paso a una persona real con un número sin calibrar es peor que el
    // problema que resuelve.
    const vida = judgeFrame(face.liveness, this.liveness);
    if (vida.suspicious) {
      this.metrics.registrarSospechaDeVida(vida.reason, this.liveness.mode);
      this.logger.warn(
        `Sospecha de suplantación (${vida.reason}) en ${point.siteName}/` +
          `${point.zoneName} · modo ${this.liveness.mode}`,
      );

      if (this.liveness.mode === 'HARD') {
        return this.deny({
          reason: 'LIVENESS_FAILED',
          sessionKey: params.sessionKey ?? this.votes.createKey(),
          faces: [verdict],
          imageWidth: recognition.imageWidth,
          imageHeight: recognition.imageHeight,
          cameraId: params.cameraId,
          point,
        });
      }
    }

    // ── Caso 4: rostro no reconocido ──────────────────────────────
    if (!face.match) {
      const vote = await this.votes.record(
        params.sessionKey,
        null,
        face.bestSimilarity,
      );
      await this.logs.record({
        personId: null,
        personName: null,
        authenticated: false,
        confidence: face.bestSimilarity,
        reason: 'BELOW_THRESHOLD',
        cameraId: params.cameraId,
        point,
      });

      return {
        authenticated: false,
        person: null,
        confidence: face.bestSimilarity,
        bbox: face.bbox,
        faces: [verdict],
        imageWidth: recognition.imageWidth,
        imageHeight: recognition.imageHeight,
        reason: 'BELOW_THRESHOLD',
        sessionKey: vote.sessionKey,
        votes: { current: 0, required: vote.required },
        location: this.toLocation(point),
      };
    }

    // ── Caso 5: reconocido, pero ¿puede pasar por AQUI y AHORA? ───
    //
    // La autorización se comprueba ANTES de acumular votos. Si alguien
    // no tiene permiso en esta zona, hacerle esperar tres frames para
    // decirle que no sería gratuito y confuso: el veredicto ya se
    // conoce desde el primero.
    const authorization = await this.policy.authorize(
      face.match.personId,
      point,
    );

    if (!authorization.allowed) {
      await this.logs.record({
        personId: face.match.personId,
        personName: face.match.fullName,
        authenticated: false,
        confidence: face.match.similarity,
        reason: authorization.reason,
        cameraId: params.cameraId,
        point,
      });

      return {
        authenticated: false,
        // Se devuelve la persona aunque se deniegue: quien está delante
        // merece saber que SI se le reconoció y que el problema es de
        // permisos, no de identidad.
        person: null,
        confidence: face.match.similarity,
        bbox: face.bbox,
        faces: [{ ...verdict, recognized: true }],
        imageWidth: recognition.imageWidth,
        imageHeight: recognition.imageHeight,
        reason: authorization.reason,
        sessionKey: params.sessionKey ?? this.votes.createKey(),
        votes: { current: 0, required: 0 },
        location: this.toLocation(point),
      };
    }

    // ── Caso 6: ¿es coherente este paso con donde esta? ───────────
    //
    // El anti-passback se evalua aqui, junto a la politica y antes de
    // votar, por el mismo motivo: el veredicto ya se conoce desde el
    // primer frame y hacer esperar tres seria gratuito.
    //
    // Se evalua ahora y se aplica despues de la votacion, asi que hay
    // aproximadamente un segundo entre la lectura del estado y su
    // escritura. En esa ventana solo caben frames de ESTA MISMA
    // persona -la presencia es suya y solo suya-, y una persona no
    // puede estar en dos puertas a la vez.
    const now = new Date();
    const antipassback = await this.presence.evaluate(
      face.match.personId,
      point,
      now,
    );

    if (antipassback.outcome === 'DENY') {
      await this.logs.record({
        personId: face.match.personId,
        personName: face.match.fullName,
        authenticated: false,
        confidence: face.match.similarity,
        reason: 'ANTIPASSBACK_VIOLATION',
        cameraId: params.cameraId,
        point,
      });

      return {
        authenticated: false,
        person: null,
        confidence: face.match.similarity,
        bbox: face.bbox,
        faces: [{ ...verdict, recognized: true }],
        imageWidth: recognition.imageWidth,
        imageHeight: recognition.imageHeight,
        reason: 'ANTIPASSBACK_VIOLATION',
        sessionKey: params.sessionKey ?? this.votes.createKey(),
        votes: { current: 0, required: 0 },
        location: this.toLocation(point),
      };
    }

    // ── Caso 7: autorizado; se acumula el voto ────────────────────
    const vote = await this.votes.record(
      params.sessionKey,
      face.match.personId,
      face.match.similarity,
    );

    if (!vote.decidedPersonId) {
      // Reconocido, pero aún no hay confirmaciones suficientes.
      return {
        authenticated: false,
        person: null,
        confidence: face.match.similarity,
        bbox: face.bbox,
        faces: [verdict],
        imageWidth: recognition.imageWidth,
        imageHeight: recognition.imageHeight,
        reason: 'INSUFFICIENT_VOTES',
        sessionKey: vote.sessionKey,
        votes: { current: vote.current, required: vote.required },
        location: this.toLocation(point),
      };
    }

    // ── Caso 8: acceso concedido ──────────────────────────────────
    //
    // La sesion, el asiento de auditoria y la presencia se escriben en
    // una sola transaccion. Si fueran escrituras sueltas y el proceso
    // muriera en medio, quedarian estados imposibles: alguien con
    // sesion abierta a quien el sistema cree fuera.
    const session = await this.passages.registerGrant({
      personId: face.match.personId,
      personName: face.match.fullName,
      confidence: vote.averageSimilarity,
      cameraId: params.cameraId,
      point,
      direction: antipassback.direction,
      anomaly: ANOMALY_BY_OUTCOME[antipassback.outcome],
      sessionTtlMs: parseTtlMs(String(this.sessionTtl)),
      now,
    });

    const accessToken = await this.jwt.signAsync(
      {
        sub: face.match.personId,
        name: face.match.fullName,
        sid: session.sessionId,
        typ: 'access-session',
      },
      { expiresIn: this.sessionTtl },
    );

    this.logger.log(
      `Acceso concedido a ${face.match.fullName}: ` +
        `${antipassback.direction === 'IN' ? 'entrada' : 'salida'} por ` +
        `${point.accessPointName} (similitud media ${vote.averageSimilarity.toFixed(3)})`,
    );

    return {
      authenticated: true,
      person: { id: face.match.personId, name: face.match.fullName },
      confidence: vote.averageSimilarity,
      bbox: face.bbox,
      faces: [{ ...verdict, recognized: true }],
      imageWidth: recognition.imageWidth,
      imageHeight: recognition.imageHeight,
      reason: 'GRANTED',
      sessionKey: vote.sessionKey,
      votes: { current: vote.current, required: vote.required },
      accessToken,
      location: this.toLocation(point),
      passage: antipassback.direction,
    };
  }

  private toLocation(point: AccessPointContext) {
    return {
      site: point.siteName,
      zone: point.zoneName,
      accessPoint: point.accessPointName,
    };
  }

  private toVerdict(face: IdentifiedFace): FaceVerdict {
    return {
      bbox: face.bbox,
      recognized: face.match !== null,
      personName: face.match?.fullName ?? null,
      personId: face.match?.personId ?? null,
      confidence: face.match?.similarity ?? face.bestSimilarity,
    };
  }

  private async deny(params: {
    reason: AccessReason;
    sessionKey: string;
    faces: FaceVerdict[];
    imageWidth: number;
    imageHeight: number;
    cameraId: string;
    point: AccessPointContext;
    skipLog?: boolean;
  }): Promise<VerifyFrameResult> {
    if (!params.skipLog) {
      await this.logs.record({
        personId: null,
        personName: null,
        authenticated: false,
        confidence: 0,
        reason: params.reason,
        cameraId: params.cameraId,
        point: params.point,
      });
    }

    return {
      authenticated: false,
      person: null,
      confidence: 0,
      bbox: params.faces[0]?.bbox ?? null,
      faces: params.faces,
      imageWidth: params.imageWidth,
      imageHeight: params.imageHeight,
      reason: params.reason,
      sessionKey: params.sessionKey,
      votes: { current: 0, required: 0 },
      location: this.toLocation(params.point),
    };
  }
}
