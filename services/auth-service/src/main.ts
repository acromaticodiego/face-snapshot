// La telemetria se arranca ANTES que ninguna otra cosa: las
// instrumentaciones parchean modulos al cargarse, y un parche que llega
// despues de que Nest haya cargado express no instrumenta nada. No
// falla, simplemente no aparece ninguna traza.
import './telemetry';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger('AuthService');

  app.use(helmet());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.setGlobalPrefix('api/v1');

  // Servicio INTERNO: solo lo llama el Gateway y el Access Service dentro
  // de la red de Docker. No se abre CORS al navegador.
  app.enableCors({ origin: false });

  const config = new DocumentBuilder()
    .setTitle('Auth Service')
    .setDescription(
      'Autenticación de administradores del sistema. ' +
        'Emite los tokens que protegen las rutas de administración.',
    )
    .setVersion('1.0.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.AUTH_SERVICE_PORT ?? 3003);
  await app.listen(port, '0.0.0.0');
  logger.log(`Auth Service escuchando en el puerto ${port}`);
  logger.log(`Swagger disponible en http://localhost:${port}/docs`);
}

void bootstrap();
