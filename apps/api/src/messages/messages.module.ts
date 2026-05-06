import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  controllers: [MessagesController],
  providers: [supabaseProvider, MessagesService],
})
export class MessagesModule {}
