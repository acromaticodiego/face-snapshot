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
import { VerificationService } from './verification.service';

@ApiTags('verification')
@Controller('auth')
export class VerificationController {
  private readonly maxImageBytes: number;

  constructor(
    private readonly verification: VerificationService,
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
    @Body('sessionKey') sessionKey?: string,
    @Body('cameraId') cameraId?: string,
  ) {
    const image = validateUploadedImage(file, this.maxImageBytes);

    return this.verification.verifyFrame({
      image: image.buffer,
      filename: image.originalname,
      mimetype: image.mimetype,
      sessionKey: sessionKey || undefined,
      cameraId: cameraId || 'default',
    });
  }
}
