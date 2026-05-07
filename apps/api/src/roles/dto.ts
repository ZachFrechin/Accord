import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsHexColor,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { Permission } from '@discord2/shared';

export class CreateServerRoleDto {
  @IsString()
  @Length(1, 40)
  name!: string;

  @IsHexColor()
  color!: string;

  @IsBoolean()
  mentionable!: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsEnum(Permission, { each: true })
  permissions?: Permission[];
}

export class UpdateServerRoleDto {
  @IsOptional()
  @IsString()
  @Length(1, 40)
  name?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsBoolean()
  mentionable?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsEnum(Permission, { each: true })
  permissions?: Permission[];
}

export class UpdateMemberRolesDto {
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  roleIds!: string[];
}

export class ReorderRolesDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  roleIds!: string[];
}
