import type { SupabaseClient } from '@supabase/supabase-js';
import type { InviteId, ServerId, UserId } from '@discord2/shared';

export interface InviteRecord {
  id: InviteId;
  serverId: ServerId;
  code: string;
  createdBy: UserId;
  expiresAt: string | null;
}

interface InviteRow {
  id: string;
  server_id: string;
  code: string;
  created_by: string;
  expires_at: string | null;
}

export class InvitesRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: {
    serverId: ServerId;
    createdBy: UserId;
    code: string;
    expiresAt: string | null;
  }): Promise<InviteRecord> {
    const { data, error } = await this.supabase
      .from('invites')
      .insert({
        server_id: input.serverId,
        created_by: input.createdBy,
        code: input.code,
        expires_at: input.expiresAt,
      })
      .select('id, server_id, code, created_by, expires_at')
      .single<InviteRow>();

    if (error) {
      throw error;
    }

    return {
      id: data.id,
      serverId: data.server_id,
      code: data.code,
      createdBy: data.created_by,
      expiresAt: data.expires_at,
    };
  }
}
