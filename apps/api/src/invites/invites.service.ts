import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { customAlphabet } from 'nanoid';
import { InvitesRepository, RolesRepository, ServersRepository } from '@discord2/db';
import {
  Permission,
  type AuthUser,
  type RedeemInviteResult,
  type ServerId,
} from '@discord2/shared';
import { MessageEventsPublisher } from '../messages/message-events.publisher';
import { PermissionsService } from '../permissions/permissions.service';
import type { CreateInviteDto } from './dto';

const createInviteCode = customAlphabet(
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  16,
);

@Injectable()
export class InvitesService {
  private readonly repository: InvitesRepository;
  private readonly serversRepository: ServersRepository;
  private readonly rolesRepository: RolesRepository;

  constructor(
    @Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient,
    private readonly permissionsService: PermissionsService,
    private readonly eventsPublisher: MessageEventsPublisher,
  ) {
    this.repository = new InvitesRepository(supabase);
    this.serversRepository = new ServersRepository(supabase);
    this.rolesRepository = new RolesRepository(supabase);
  }

  async createInvite(user: AuthUser, serverId: ServerId, dto: CreateInviteDto) {
    await this.permissionsService.assertServerPermission(user, serverId, Permission.CreateInvites);

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

    const banned = await this.serversRepository.findBan(invite.serverId, user.id);
    if (banned) {
      throw new ForbiddenException('You are banned from this server.');
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

    const members = await this.rolesRepository.listMembers(invite.serverId);
    await this.eventsPublisher.publishServerStateChanged({
      serverId: invite.serverId,
      userIds: members.map((member) => member.userId),
      reason: 'members',
      targetUserId: user.id,
    });

    return { server };
  }
}
