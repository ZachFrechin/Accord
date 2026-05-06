import type { SupabaseClient } from '@supabase/supabase-js';
import type { InviteId, InviteRecord, ServerId, UserId } from '@discord2/shared';

interface InviteRow {
  id: string;
  server_id: string;
  code: string;
  created_by: string;
  expires_at: string | null;
  used_by: string | null;
  used_at: string | null;
  created_at: string;
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
      .select('id, server_id, code, created_by, expires_at, used_by, used_at, created_at')
      .single<InviteRow>();

    if (error) {
      throw error;
    }

    return mapInviteRow(data);
  }

  async findActiveByCode(code: string): Promise<InviteRecord | null> {
    const { data, error } = await this.supabase
      .from('invites')
      .select('id, server_id, code, created_by, expires_at, used_by, used_at, created_at')
      .eq('code', code)
      .is('used_at', null)
      .maybeSingle<InviteRow>();

    if (error) {
      throw error;
    }

    if (!data) {
      return null;
    }

    if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
      return null;
    }

    return mapInviteRow(data);
  }

  async markUsed(input: { inviteId: InviteId; userId: UserId }): Promise<void> {
    const { error } = await this.supabase
      .from('invites')
      .update({
        used_by: input.userId,
        used_at: new Date().toISOString(),
      })
      .eq('id', input.inviteId);

    if (error) {
      throw error;
    }
  }
}

function mapInviteRow(row: InviteRow): InviteRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    code: row.code,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    usedBy: row.used_by,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}
