import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.usersService.me(user);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    try {
      return await this.usersService.getProfile(id);
    } catch {
      throw new NotFoundException('User not found.');
    }
  }
}
