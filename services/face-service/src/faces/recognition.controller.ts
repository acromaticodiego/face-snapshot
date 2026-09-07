import {
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
import { FacesService } from './faces.service';

/**
 * Endpoint INTERNO de reconocimiento.
 *
 * Lo consume el Access Service, nunca el navegador. Devuelve identidades
 * y similitudes, pero NUNCA embeddings: los vectores se quedan dentro de
 * la frontera del Face Service.
 */
@ApiTags('recognition (interno)')
@Controller('recognition')
export class RecognitionController {
  private readonly maxImageBytes: number;

  constructor(
    private readonly faces: FacesService,
    config: ConfigService,
  ) {
    this.maxImageBytes = Number(config.get('MAX_IMAGE_SIZE_MB', 8)) * 1024 * 1024;
  }

  @Post('identify')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Detecta rostros en un frame e identifica a sus titulares',
  })
  @UseInterceptors(FileInterceptor('file'))
  async identify(@UploadedFile() file: UploadedImage) {
    const image = validateUploadedImage(file, this.maxImageBytes);

    const { analysis, results } = await this.faces.identifyFromImage(
      image.buffer,
      image.originalname,
      image.mimetype,
    );

    return {
      imageWidth: analysis.imageWidth,
      imageHeight: analysis.imageHeight,
      processingTimeMs: analysis.processingTimeMs,
      // Se proyecta explícitamente cada campo. Nunca se hace spread del
      // objeto `face`, porque arrastraría el embedding.
      faces: results.map(({ face, identity }) => ({
        bbox: face.bbox,
        detectionScore: face.detectionScore,
        quality: face.quality,
        match: identity.match,
        bestSimilarity: identity.bestSimilarity,
      })),
    };
  }
}
