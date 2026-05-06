import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ProfilesRepository } from '@discord2/db';
import type { AuthUser, UserProfile } from '@discord2/shared';

@Injectable()
export class UsersService {
  private readonly profilesRepository: ProfilesRepository;

  constructor(@Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient) {
    this.profilesRepository = new ProfilesRepository(supabase);
  }

  me(user: AuthUser): Promise<UserProfile> {
    return this.profilesRepository.upsertFromAuthUser(user);
  }
}
