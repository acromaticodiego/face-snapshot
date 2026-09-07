import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger('ApiGateway');

  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.setGlobalPrefix('api/v1');

  // Este es el ÚNICO servicio que el navegador puede alcanzar, así que es
  // el único con CORS abierto, y solo a los orígenes declarados.
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: origins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: true,
    maxAge: 86_400,
  });

  const config = new DocumentBuilder()
    .setTitle('API Gateway — Reconocimiento facial')
    .setDescription(
      'Único punto de entrada del frontend. Enruta hacia el Face Service ' +
        'y el Access Service. No contiene lógica de reconocimiento.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.GATEWAY_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  logger.log(`API Gateway escuchando en el puerto ${port}`);
  logger.log(`Swagger disponible en http://localhost:${port}/docs`);
  logger.log(`CORS permitido para: ${origins.join(', ')}`);
}

void bootstrap();
