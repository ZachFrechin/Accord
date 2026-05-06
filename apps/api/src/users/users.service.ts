import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ProfilesRepository } from '@discord2/db';
import type { AuthUser, UserProfile } from '@discord2/shared';
import { assertPublicStorageUrl } from '../common/storage-url.validator';
import type { UpdateProfileDto } from './dto';

@Injectable()
export class UsersService {
  private readonly profilesRepository: ProfilesRepository;

  constructor(@Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient) {
    this.profilesRepository = new ProfilesRepository(supabase);
  }

  me(user: AuthUser): Promise<UserProfile> {
    return this.profilesRepository.upsertFromAuthUser(user);
  }

  async updateMe(user: AuthUser, dto: UpdateProfileDto): Promise<UserProfile> {
    const displayName = dto.displayName.trim();
    if (!displayName) {
      throw new BadRequestException('Display name is required.');
    }

    assertPublicStorageUrl(dto.avatarUrl, 'profile-avatars');
    await this.profilesRepository.upsertFromAuthUser(user);

    return this.profilesRepository.updateForUser(user, {
      displayName,
      avatarUrl: dto.avatarUrl,
    });
  }

  async getProfile(userId: string): Promise<UserProfile> {
    const profile = await this.profilesRepository.findByUserId(userId);
    if (!profile) {
      throw new NotFoundException('User not found.');
    }

    return profile;
  }
}
