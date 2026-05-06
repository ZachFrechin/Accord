import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { customAlphabet } from 'nanoid';
import { InvitesRepository, ServersRepository } from '@discord2/db';
import type { AuthUser, RedeemInviteResult, ServerId } from '@discord2/shared';
import { canCreateInvite } from '@discord2/domain';
import type { CreateInviteDto } from './dto';

const createInviteCode = customAlphabet(
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  16,
);

@Injectable()
export class InvitesService {
  private readonly repository: InvitesRepository;
  private readonly serversRepository: ServersRepository;

  constructor(@Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient) {
    this.repository = new InvitesRepository(supabase);
    this.serversRepository = new ServersRepository(supabase);
  }

  async createInvite(user: AuthUser, serverId: ServerId, dto: CreateInviteDto) {
    const membership = await this.serversRepository.findMembership(serverId, user.id);
    if (!membership || !canCreateInvite(membership)) {
      throw new ForbiddenException('You cannot create invites for this server.');
    }

    return this.repository.create({
      serverId,
      createdBy: user.id,
      code: createInviteCode(),
      expiresAt: dto.expiresAt ?? null,
    });
  }

  async redeemInvite(user: AuthUser, code: string): Promise<RedeemInviteResult> {
    const invite = await this.repository.findActiveByCode(code);
    if (!invite) {
      throw new NotFoundException('Invite not found.');
    }

    await this.serversRepository.addMember({
      serverId: invite.serverId,
      userId: user.id,
    });
    await this.repository.markUsed({
      inviteId: invite.id,
      userId: user.id,
    });

    const server = await this.serversRepository.findByIdForUser(invite.serverId, user.id);
    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    return { server };
  }
}
