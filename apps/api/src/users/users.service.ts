import { Inject, Injectable, NotFoundException } from '@nestjs/common';
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

  async getProfile(userId: string): Promise<UserProfile> {
    const profile = await this.profilesRepository.findByUserId(userId);
    if (!profile) {
      throw new NotFoundException('User not found.');
    }

    return profile;
  }
}
