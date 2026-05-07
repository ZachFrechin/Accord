import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { ServersModule } from '../servers/servers.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  imports: [ServersModule],
  controllers: [FilesController],
  providers: [supabaseProvider, FilesService],
})
export class FilesModule {}
