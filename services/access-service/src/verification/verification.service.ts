import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import type { JwtSignOptions } from '@nestjs/jwt';

import { AccessLogsService } from '../logs/access-logs.service';
import { FaceClient, IdentifiedFace } from '../face/face.client';
import { VoteWindowService } from './vote-window.service';

export type AccessReason =
  | 'GRANTED'
  | 'BELOW_THRESHOLD'
  | 'NO_FACE_DETECTED'
  | 'MULTIPLE_FACES'
  | 'LOW_QUALITY'
  | 'INSUFFICIENT_VOTES'
  | 'PERSON_SUSPENDED';

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
}

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

  constructor(
    private readonly faceClient: FaceClient,
    private readonly votes: VoteWindowService,
    private readonly logs: AccessLogsService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.sessionTtl = config.get<string>(
      'JWT_EXPIRES_IN',
      '15m',
    ) as NonNullable<JwtSignOptions['expiresIn']>;
  }

  async verifyFrame(params: {
    image: Buffer;
    filename: string;
    mimetype: string;
    sessionKey?: string;
    cameraId: string;
  }): Promise<VerifyFrameResult> {
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
      });
    }

    const face = recognition.faces[0];
    const verdict = this.toVerdict(face);

    // ── Caso 3: rostro no reconocido ──────────────────────────────
    if (!face.match) {
      const vote = this.votes.record(params.sessionKey, null, face.bestSimilarity);
      await this.logs.record({
        personId: null,
        personName: null,
        authenticated: false,
        confidence: face.bestSimilarity,
        reason: 'BELOW_THRESHOLD',
        cameraId: params.cameraId,
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
      };
    }

    // ── Caso 4: reconocido; se acumula el voto ────────────────────
    const vote = this.votes.record(
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
      };
    }

    // ── Caso 5: acceso concedido ──────────────────────────────────
    const session = await this.logs.openSession({
      personId: face.match.personId,
      personName: face.match.fullName,
      ttl: String(this.sessionTtl),
    });

    await this.logs.record({
      personId: face.match.personId,
      personName: face.match.fullName,
      authenticated: true,
      confidence: vote.averageSimilarity,
      reason: 'GRANTED',
      cameraId: params.cameraId,
      sessionId: session.id,
    });

    const accessToken = await this.jwt.signAsync(
      {
        sub: face.match.personId,
        name: face.match.fullName,
        sid: session.id,
        typ: 'access-session',
      },
      { expiresIn: this.sessionTtl },
    );

    this.logger.log(
      `Acceso concedido a ${face.match.fullName} (similitud media ${vote.averageSimilarity.toFixed(3)})`,
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
    };
  }
}
