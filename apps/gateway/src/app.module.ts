import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { RealtimeModule } from './realtime/realtime.module';

@Module({
  imports: [HealthModule, RealtimeModule],
})
export class AppModule {}
