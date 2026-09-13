import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  UploadedImage,
  validateUploadedImage,
} from '../common/uploaded-image';
import { DomainMetrics } from '../telemetry/domain.metrics';
import { VerificationService } from './verification.service';

@ApiTags('verification')
@Controller('auth')
export class VerificationController {
  private readonly maxImageBytes: number;

  constructor(
    private readonly verification: VerificationService,
    private readonly metrics: DomainMetrics,
    config: ConfigService,
  ) {
    this.maxImageBytes = Number(config.get('MAX_IMAGE_SIZE_MB', 8)) * 1024 * 1024;
  }

  @Post('verify-frame')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Verifica un frame de la cámara y decide si concede el acceso',
    description:
      'Devuelve las cajas para dibujar y el veredicto. El acceso solo se ' +
      'concede tras acumular suficientes coincidencias consecutivas de la ' +
      'misma persona.',
  })
  @UseInterceptors(FileInterceptor('file'))
  async verifyFrame(
    @UploadedFile() file: UploadedImage,
    @Body('terminalKey') terminalKey?: string,
    @Body('sessionKey') sessionKey?: string,
    @Body('cameraId') cameraId?: string,
  ) {
    const image = validateUploadedImage(file, this.maxImageBytes);

    const result = await this.verification.verifyFrame({
      image: image.buffer,
      filename: image.originalname,
      mimetype: image.mimetype,
      sessionKey: sessionKey || undefined,
      cameraId: cameraId || 'default',
      // Identifica la puerta física. Sin ella no se puede autorizar:
      // el permiso depende de la zona, no solo de la persona.
      terminalKey: terminalKey || '',
    });

    // Se mide AQUI, sobre el resultado final, y no en cada uno de los
    // diez y pico puntos donde el servicio decide denegar. Un contador
    // repartido por todas las salidas de un método se desincroniza en
    // cuanto alguien añade un motivo nuevo y se olvida de una; sobre el
    // valor devuelto, medir lo que se responde es imposible de
    // desincronizar de lo que se responde.
    this.metrics.registrarDecision(
      result.reason,
      result.location?.site ?? 'desconocida',
      result.location?.zone ?? 'desconocida',
    );

    // Solo si hubo rostro que comparar. Contar un 0 por cada frame sin
    // cara arrastraría la distribución hacia abajo y el histograma
    // dejaría de decir nada sobre el margen del umbral.
    if (result.faces.length > 0) {
      this.metrics.registrarSimilitud(result.confidence);
    }

    return result;
  }
}
