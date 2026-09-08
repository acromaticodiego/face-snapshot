import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  UploadedImage,
  validateUploadedImage,
} from '../common/uploaded-image';
import { AccessServiceClient } from '../proxy/service-clients';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly maxImageBytes: number;

  constructor(
    private readonly access: AccessServiceClient,
    config: ConfigService,
  ) {
    this.maxImageBytes = Number(config.get('MAX_IMAGE_SIZE_MB', 8)) * 1024 * 1024;
  }

  /**
   * Verifica un frame de la cámara.
   *
   * El Gateway solo valida el archivo y reenvía. La decisión de conceder
   * el acceso se toma íntegramente en el Access Service.
   */
  @Post('verify-frame')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Envía un frame y recibe el veredicto de acceso' })
  // Límite generoso: la pantalla de autenticación envía ~5 frames por
  // segundo. Aun así hay tope, para que nadie pueda usar el endpoint
  // como oráculo y probar rostros de forma masiva.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file'))
  async verifyFrame(
    @UploadedFile() file: UploadedImage,
    @Body('terminalKey') terminalKey?: string,
    @Body('sessionKey') sessionKey?: string,
    @Body('cameraId') cameraId?: string,
  ) {
    const image = validateUploadedImage(file, this.maxImageBytes);

    return this.access.verifyFrame({
      image: image.buffer,
      filename: image.originalname,
      mimetype: image.mimetype,
      sessionKey,
      cameraId,
      terminalKey,
    });
  }
}
