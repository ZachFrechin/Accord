import { Type } from 'class-transformer';
import {
  Matches,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsArray,
  Max,
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

export class CreateAttachmentDto {
  @IsString()
  @IsNotEmpty()
  storagePath!: string;

  @IsString()
  @IsNotEmpty()
  mimeType!: string;

  @IsInt()
  @Min(1)
  @Max(25 * 1024 * 1024)
  byteSize!: number;

  @IsString()
  @IsOptional()
  fileName?: string;

  @IsBoolean()
  @IsOptional()
  isE2ee?: boolean;

  @IsObject()
  @ValidateNested()
  @Type(() => EncryptedPayloadDto)
  @IsOptional()
  encrypted?: EncryptedPayloadDto;
}

export class CreateMessageDto {
  @IsEnum(MessagePrivacy)
  privacy!: typeof MessagePrivacy.EndToEndEncrypted;

  @IsObject()
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => EncryptedPayloadDto)
  encrypted!: EncryptedPayloadDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateAttachmentDto)
  @IsOptional()
  attachments?: CreateAttachmentDto[];
}

export class UpdateMessageDto {
  @IsObject()
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => EncryptedPayloadDto)
  encrypted!: EncryptedPayloadDto;
}

export class ToggleMessageReactionDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F]{1,8}$/u)
  emoji!: string;
}
