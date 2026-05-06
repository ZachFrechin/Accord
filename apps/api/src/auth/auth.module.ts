import { Module } from '@nestjs/common';
import { SupabaseAuthService } from './supabase-auth.service';

@Module({
  providers: [SupabaseAuthService],
  exports: [SupabaseAuthService],
})
export class AuthModule {}
