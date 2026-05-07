import 'reflect-metadata';
import { json, raw, urlencoded } from 'express';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { loadServerEnv, parseCorsOrigins } from '@discord2/config';

async function bootstrap(): Promise<void> {
  const env = loadServerEnv();
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.use('/files/upload', raw({ type: '*/*', limit: '30mb' }));
  app.use(json({ limit: env.API_BODY_LIMIT }));
  app.use(urlencoded({ extended: false, limit: env.API_BODY_LIMIT }));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.enableCors({
    origin: parseCorsOrigins(env.API_CORS_ORIGINS),
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(env.API_PORT, '0.0.0.0');
}

void bootstrap();
