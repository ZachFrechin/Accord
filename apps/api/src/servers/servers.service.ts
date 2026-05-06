import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ServersRepository } from '@discord2/db';
import type { AuthUser, ServerId, ServerSummary } from '@discord2/shared';
import type { CreateServerDto } from './dto';

@Injectable()
export class ServersService {
  private readonly repository: ServersRepository;

  constructor(@Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient) {
    this.repository = new ServersRepository(supabase);
  }

  listServers(user: AuthUser): Promise<ServerSummary[]> {
    return this.repository.listForUser(user.id);
  }

  createServer(user: AuthUser, dto: CreateServerDto): Promise<ServerSummary> {
    return this.repository.create({
      name: dto.name.trim(),
      ownerId: user.id,
    });
  }

  async requireMembership(user: AuthUser, serverId: ServerId): Promise<ServerSummary> {
    const server = await this.repository.findByIdForUser(serverId, user.id);
    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    return server;
  }
}
