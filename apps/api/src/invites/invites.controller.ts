import { Body, Controller, Param, Post } from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateInviteDto } from './dto';
import { InvitesService } from './invites.service';

@Controller('servers/:serverId/invites')
export class InvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Body() body: CreateInviteDto,
  ) {
    return this.invitesService.createInvite(user, serverId, body);
  }
}

@Controller('invites')
export class RedeemInvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  @Post(':code/redeem')
  redeem(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.invitesService.redeemInvite(user, code);
  }
}
