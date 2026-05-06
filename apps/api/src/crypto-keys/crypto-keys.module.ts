import { Module } from '@nestjs/common';
import { CryptoKeysController } from './crypto-keys.controller';

@Module({
  controllers: [CryptoKeysController],
})
export class CryptoKeysModule {}
