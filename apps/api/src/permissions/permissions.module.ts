import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { PermissionsService } from './permissions.service';

@Module({
  providers: [supabaseProvider, PermissionsService],
  exports: [PermissionsService],
})
export class PermissionsModule {}
