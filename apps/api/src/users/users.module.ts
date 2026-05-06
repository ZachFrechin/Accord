import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [supabaseProvider, UsersService],
  exports: [UsersService],
})
export class UsersModule {}
