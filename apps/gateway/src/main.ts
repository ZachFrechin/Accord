import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadServerEnv } from '@discord2/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const env = loadServerEnv();
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  await app.listen(env.GATEWAY_PORT, '0.0.0.0');
}

void bootstrap();
