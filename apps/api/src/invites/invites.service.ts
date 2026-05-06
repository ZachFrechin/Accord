import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { customAlphabet } from 'nanoid';
import { InvitesRepository } from '@discord2/db';
import type { AuthUser, ServerId } from '@discord2/shared';
import type { CreateInviteDto } from './dto';

const createInviteCode = customAlphabet(
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  16,
);

@Injectable()
export class InvitesService {
  private readonly repository: InvitesRepository;

  constructor(@Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient) {
    this.repository = new InvitesRepository(supabase);
  }

  createInvite(user: AuthUser, serverId: ServerId, dto: CreateInviteDto) {
    return this.repository.create({
      serverId,
      createdBy: user.id,
      code: createInviteCode(),
      expiresAt: dto.expiresAt ?? null,
    });
  }
}
