import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { PermissionsModule } from '../permissions/permissions.module';
import { ServersModule } from '../servers/servers.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  imports: [ServersModule, PermissionsModule],
  controllers: [FilesController],
  providers: [supabaseProvider, FilesService],
})
export class FilesModule {}
