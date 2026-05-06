import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthUser, UserProfile } from '@discord2/shared';

interface ProfileRow {
  id: string;
  display_name: string;
  avatar_url: string | null;
}

export class ProfilesRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async upsertFromAuthUser(user: AuthUser): Promise<UserProfile> {
    const existing = await this.findByAuthUser(user);
    if (existing) {
      return existing;
    }

    const displayName = user.email?.split('@')[0] || 'User';
    const { data, error } = await this.supabase
      .from('profiles')
      .insert({
        id: user.id,
        display_name: displayName,
      })
      .select('id, display_name, avatar_url')
      .single<ProfileRow>();

    if (error) {
      throw error;
    }

    return mapProfileRow(data, user.email);
  }

  async findByUserId(userId: string): Promise<UserProfile | null> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('id, display_name, avatar_url')
      .eq('id', userId)
      .maybeSingle<ProfileRow>();

    if (error) {
      throw error;
    }

    return data ? mapProfileRow(data, null) : null;
  }

  private async findByAuthUser(user: AuthUser): Promise<UserProfile | null> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('id, display_name, avatar_url')
      .eq('id', user.id)
      .maybeSingle<ProfileRow>();

    if (error) {
      throw error;
    }

    return data ? mapProfileRow(data, user.email) : null;
  }
}

function mapProfileRow(row: ProfileRow, email: string | null): UserProfile {
  return {
    id: row.id,
    email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}
