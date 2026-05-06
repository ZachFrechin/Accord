import type { SupabaseClient } from '@supabase/supabase-js';
import type { ServerId, ServerMember, ServerSummary, UserId } from '@discord2/shared';

interface ServerRow {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  server_members?: Array<{
    role: ServerMember['role'];
  }>;
}

interface ServerMemberRow {
  server_id: string;
  user_id: string;
  role: ServerMember['role'];
}

export class ServersRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async listForUser(userId: UserId): Promise<ServerSummary[]> {
    const { data, error } = await this.supabase
      .from('servers')
      .select('id, name, owner_id, created_at, server_members!inner(role)')
      .eq('server_members.user_id', userId)
      .order('created_at', { ascending: true })
      .returns<ServerRow[]>();

    if (error) {
      throw error;
    }

    return data.map((row) => mapServerRow(row, row.server_members?.[0]?.role ?? 'member'));
  }

  async create(input: { name: string; ownerId: UserId }): Promise<ServerSummary> {
    const { data: server, error: serverError } = await this.supabase
      .from('servers')
      .insert({
        name: input.name,
        owner_id: input.ownerId,
      })
      .select('id, name, owner_id, created_at')
      .single<ServerRow>();

    if (serverError) {
      throw serverError;
    }

    const { error: memberError } = await this.supabase.from('server_members').insert({
      server_id: server.id,
      user_id: input.ownerId,
      role: 'owner',
    });

    if (memberError) {
      throw memberError;
    }

    return mapServerRow(server, 'owner');
  }

  async findMembership(serverId: ServerId, userId: UserId): Promise<ServerMember | null> {
    const { data, error } = await this.supabase
      .from('server_members')
      .select('server_id, user_id, role')
      .eq('server_id', serverId)
      .eq('user_id', userId)
      .maybeSingle<ServerMemberRow>();

    if (error) {
      throw error;
    }

    if (!data) {
      return null;
    }

    return {
      serverId: data.server_id,
      userId: data.user_id,
      role: data.role,
    };
  }

  async addMember(input: { serverId: ServerId; userId: UserId }): Promise<void> {
    const { error } = await this.supabase.from('server_members').upsert(
      {
        server_id: input.serverId,
        user_id: input.userId,
        role: 'member',
      },
      { onConflict: 'server_id,user_id' },
    );

    if (error) {
      throw error;
    }
  }

  async findByIdForUser(serverId: ServerId, userId: UserId): Promise<ServerSummary | null> {
    const servers = await this.listForUser(userId);
    return servers.find((server) => server.id === serverId) ?? null;
  }
}

function mapServerRow(row: ServerRow, role: ServerMember['role']): ServerSummary {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    role,
    createdAt: row.created_at,
  };
}
