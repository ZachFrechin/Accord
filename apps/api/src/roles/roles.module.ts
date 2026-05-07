import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { PermissionsModule } from '../permissions/permissions.module';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Module({
  imports: [PermissionsModule],
  controllers: [RolesController],
  providers: [supabaseProvider, RolesService],
  exports: [RolesService],
})
export class RolesModule {}
