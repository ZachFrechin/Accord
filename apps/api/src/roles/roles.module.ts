import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Module({
  controllers: [RolesController],
  providers: [supabaseProvider, RolesService],
  exports: [RolesService],
})
export class RolesModule {}
