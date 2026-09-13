import { BadRequestException } from '@nestjs/common';

import type { UploadedImage } from './uploaded-image';

/**
 * Valida un audio antes de mandarlo al servicio de voz.
 *
 * MISMO CRITERIO QUE CON LAS IMAGENES, Y POR EL MISMO MOTIVO
 * ──────────────────────────────────────────────────────────
 * El `content-type` que declara el cliente no es de fiar, así que
 * además se comprueban los "números mágicos" de la cabecera. Aquí pesa
 * incluso más que con una imagen: lo que se suba acaba enviándose a un
 * TERCERO, y aceptar cualquier cosa sería dejar que un cliente eligiera
 * qué le mandamos a Deepgram.
 *
 * La forma del archivo se reutiliza de `uploaded-image.ts`: son los
 * mismos cuatro campos, y declarar una interfaz idéntica al lado solo
 * daría dos sitios donde equivocarse.
 */
export type UploadedAudio = UploadedImage;

/**
 * Lo que produce `MediaRecorder` en un navegador -webm y ogg- más los
 * formatos habituales de un dictáfono.
 */
export const ALLOWED_AUDIO_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/flac',
];

export function validateUploadedAudio(
  file: UploadedAudio | undefined,
  maxBytes: number,
): UploadedAudio {
  if (!file) {
    throw new BadRequestException('No se recibió ningún audio');
  }

  // El navegador añade los parámetros del códec
  // ("audio/webm;codecs=opus"): se compara solo el tipo.
  const declarado = (file.mimetype || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_AUDIO_TYPES.includes(declarado)) {
    throw new BadRequestException(
      `Formato no permitido: ${file.mimetype || 'sin declarar'}. ` +
        `Se aceptan: ${ALLOWED_AUDIO_TYPES.join(', ')}.`,
    );
  }
  if (file.size > maxBytes) {
    throw new BadRequestException(
      `El audio supera el límite de ${Math.round(maxBytes / 1024 / 1024)} MB`,
    );
  }
  if (!hasAudioSignature(file.buffer)) {
    throw new BadRequestException('El archivo no es un audio válido');
  }

  return { ...file, mimetype: declarado };
}

/**
 * Reconoce los contenedores por su cabecera.
 *
 * No pretende validar el flujo entero —eso lo hará el transcriptor—,
 * solo descartar lo que ni siquiera empieza como un audio.
 */
function hasAudioSignature(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;

  const ascii = (desde: number, hasta: number) =>
    buffer.toString('ascii', desde, hasta);

  // WebM y Matroska comparten la cabecera EBML: 1A 45 DF A3.
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return true;
  }

  // Ogg: "OggS"
  if (ascii(0, 4) === 'OggS') return true;

  // WAV: "RIFF" .... "WAVE"
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return true;

  // FLAC: "fLaC"
  if (ascii(0, 4) === 'fLaC') return true;

  // MP4 / M4A: el tamaño del box y después "ftyp".
  if (ascii(4, 8) === 'ftyp') return true;

  // MP3: o empieza con una etiqueta ID3, o directamente con una trama
  // cuyo sincronismo son once bits a uno.
  if (ascii(0, 3) === 'ID3') return true;
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return true;

  return false;
}
