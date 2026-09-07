import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { ZodType } from 'zod';

/**
 * Valida el cuerpo de la petición contra un esquema Zod.
 *
 * Se usa Zod en lugar de class-validator porque los mismos esquemas se
 * comparten con el frontend y con el resto de servicios desde
 * `packages/contracts`: una sola definición del contrato, validada de
 * forma idéntica en ambos extremos.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Datos de entrada inválidos',
        code: 'VALIDATION_ERROR',
        details: result.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(raíz)',
          message: issue.message,
        })),
      });
    }

    return result.data;
  }
}
