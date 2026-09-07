import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Formato uniforme de error para todos los servicios.
 *
 * Los errores inesperados NO exponen su mensaje interno al cliente: un
 * fallo de base de datos podría filtrar nombres de tablas o fragmentos
 * de consulta (que en este sistema pueden contener vectores). El detalle
 * completo queda en el log del servidor.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | object = 'Error interno del servidor';
    let code: string | undefined;
    let details: unknown;

    if (isHttp) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        const obj = body as Record<string, unknown>;
        message = (obj.message as string) ?? exception.message;
        code = obj.code as string | undefined;
        details = obj.details;
      }
    } else {
      this.logger.error(
        `Error no controlado en ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      error: HttpStatus[status] ?? 'ERROR',
      message,
      ...(code ? { code } : {}),
      ...(details ? { details } : {}),
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
