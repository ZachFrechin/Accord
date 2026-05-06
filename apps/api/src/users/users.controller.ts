import { Controller, Get } from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';

@Controller('users')
export class UsersController {
  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
