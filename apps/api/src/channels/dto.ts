import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ChannelPermissionOverwriteTargetType, ChannelType, Permission } from '@discord2/shared';

export class CreateChannelDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsEnum(ChannelType)
  type!: typeof ChannelType.Text | typeof ChannelType.Voice;
}

export class UpdateChannelDto {
  @IsString()
  @Length(1, 80)
  name!: string;
}

export class ChannelPermissionOverwriteDto {
  @IsEnum(ChannelPermissionOverwriteTargetType)
  targetType!: ChannelPermissionOverwriteTargetType;

  @IsOptional()
  @IsString()
  targetId!: string | null;

  @IsArray()
  @ArrayMaxSize(30)
  @IsEnum(Permission, { each: true })
  allowPermissions!: Permission[];

  @IsArray()
  @ArrayMaxSize(30)
  @IsEnum(Permission, { each: true })
  denyPermissions!: Permission[];
}

export class UpdateChannelPermissionsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChannelPermissionOverwriteDto)
  overwrites!: ChannelPermissionOverwriteDto[];
}
