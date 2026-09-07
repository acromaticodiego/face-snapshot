import { BadRequestException } from '@nestjs/common';

/**
 * Forma mínima de un archivo subido.
 *
 * Se declara aquí en lugar de depender de `Express.Multer.File` para no
 * arrastrar los tipos de multer a un servicio que solo necesita estos
 * cuatro campos.
 */
export interface UploadedImage {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
];

/**
 * Valida una imagen antes de enviarla al servicio de visión.
 *
 * El content-type que declara el cliente no es de fiar, así que además
 * se comprueban los "números mágicos" de la cabecera del archivo: es lo
 * que impide que alguien suba un ejecutable renombrado a .jpg.
 */
export function validateUploadedImage(
  file: UploadedImage | undefined,
  maxBytes: number,
): UploadedImage {
  if (!file) {
    throw new BadRequestException('No se recibió ninguna imagen');
  }
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    throw new BadRequestException(
      `Formato no permitido: ${file.mimetype}. Se aceptan JPEG, PNG y WebP.`,
    );
  }
  if (file.size > maxBytes) {
    throw new BadRequestException(
      `La imagen supera el límite de ${Math.round(maxBytes / 1024 / 1024)} MB`,
    );
  }
  if (!hasImageSignature(file.buffer)) {
    throw new BadRequestException(
      'El archivo no es una imagen válida',
    );
  }
  return file;
}

function hasImageSignature(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, i) => buffer[i] === byte)) return true;

  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return true;
  }

  return false;
}
