import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { ServersModule } from '../servers/servers.module';
import { InvitesController, RedeemInvitesController } from './invites.controller';
import { InvitesService } from './invites.service';

@Module({
  imports: [ServersModule],
  controllers: [InvitesController, RedeemInvitesController],
  providers: [supabaseProvider, InvitesService],
})
export class InvitesModule {}
