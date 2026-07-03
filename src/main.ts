import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { AppModule } from './app.module';
import { PublicApiModule } from './modules/public-api/public-api.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // helmet blocks cross-origin media by default; relax that for <audio>/<img>
  // tags served by this API (same origin, but browsers enforce CORP).
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.setGlobalPrefix('api/v1');

  // Serve locally-stored user uploads (audio, etc.) before the global prefix
  // kicks in. This is set up pre-prefix so the path matches both in dev and
  // behind the reverse-proxy.
  const uploadsDir = path.resolve(
    config.get<string>('UPLOADS_DIR') || path.join(process.cwd(), 'uploads'),
  );
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  app.use(
    '/api/v1/uploads',
    express.static(uploadsDir, {
      maxAge: '30d',
      fallthrough: false,
      index: false,
    }),
  );
  app.enableCors({
    origin: config.get<string>('CORS_ORIGIN', 'http://localhost:3000'),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor(), new ResponseInterceptor());

  const swagger = new DocumentBuilder()
    .setTitle('Chat BullQ API')
    .setDescription('Omnichannel customer service API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));

  // Dedicated public API docs — only the PublicApiModule surface, published
  // separately from the internal /docs.
  const publicSwagger = new DocumentBuilder()
    .setTitle('Chat BullQ — Public API')
    .setDescription(
      'API pública de integração (contatos, canais, conversas, mensagens). Autentique com Authorization: Bearer <API_KEY>.',
    )
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', name: 'Authorization', in: 'header' }, 'api-key')
    .build();
  const publicDoc = SwaggerModule.createDocument(app, publicSwagger, {
    include: [PublicApiModule],
  });
  SwaggerModule.setup('docs/public', app, publicDoc);

  const port = config.get<number>('PORT', 3001);
  await app.listen(port);
  logger.log(`API running on http://localhost:${port}`);
  logger.log(`Swagger docs at http://localhost:${port}/docs`);
  logger.log(`Public API docs at http://localhost:${port}/docs/public`);
}

bootstrap();
