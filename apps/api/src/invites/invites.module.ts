import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';

@Module({
  controllers: [InvitesController],
  providers: [supabaseProvider, InvitesService],
})
export class InvitesModule {}
