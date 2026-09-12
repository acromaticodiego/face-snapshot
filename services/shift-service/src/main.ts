import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger('ShiftService');

  app.use(helmet());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.setGlobalPrefix('api/v1');

  // Servicio INTERNO: solo lo llama el Gateway dentro de la red de
  // Docker. No se abre CORS al navegador.
  app.enableCors({ origin: false });

  const config = new DocumentBuilder()
    .setTitle('Shift Service')
    .setDescription(
      'Estado de turno, línea de tiempo de la jornada y horas ' +
        'trabajadas. Es una proyección de los eventos del Access ' +
        'Service: no decide nada que abra una puerta.',
    )
    .setVersion('1.0.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.SHIFT_SERVICE_PORT ?? 3004);
  await app.listen(port, '0.0.0.0');
  logger.log(`Shift Service escuchando en el puerto ${port}`);
  logger.log(`Swagger disponible en http://localhost:${port}/docs`);
}

void bootstrap();
