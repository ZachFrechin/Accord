import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNotEmpty, IsString, Min, ValidateNested } from 'class-validator';

export class PublishCryptoDeviceDto {
  @IsString()
  @IsNotEmpty()
  deviceId!: string;

  @IsString()
  @IsNotEmpty()
  publicKey!: string;
}

export class WrappedConversationKeyDto {
  @IsString()
  @IsNotEmpty()
  deviceId!: string;

  @IsInt()
  @Min(1)
  keyVersion!: number;

  @IsString()
  @IsNotEmpty()
  wrappedKey!: string;
}

export class BootstrapConversationDto {
  @IsString()
  @IsNotEmpty()
  deviceId!: string;

  @IsInt()
  @Min(1)
  currentKeyVersion!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WrappedConversationKeyDto)
  wrappedKeys!: WrappedConversationKeyDto[];
}

export class AddConversationKeysDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WrappedConversationKeyDto)
  wrappedKeys!: WrappedConversationKeyDto[];
}
