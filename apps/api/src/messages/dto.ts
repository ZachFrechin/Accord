import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { MessagePrivacy } from '@discord2/shared';

export class EncryptedPayloadDto {
  @IsString()
  @IsNotEmpty()
  algorithm!: 'xchacha20poly1305-ietf';

  @IsString()
  @IsNotEmpty()
  ciphertext!: string;

  @IsString()
  @IsNotEmpty()
  nonce!: string;

  @IsInt()
  @Min(1)
  keyVersion!: number;

  @IsString()
  @IsNotEmpty()
  senderDeviceId!: string;
}

export class CreateMessageDto {
  @IsEnum(MessagePrivacy)
  privacy!: MessagePrivacy;

  @IsString()
  @IsOptional()
  content?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => EncryptedPayloadDto)
  @IsOptional()
  encrypted?: EncryptedPayloadDto;
}
