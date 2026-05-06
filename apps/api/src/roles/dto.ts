import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export class CreateServerRoleDto {
  @IsString()
  @Length(1, 40)
  name!: string;

  @IsHexColor()
  color!: string;

  @IsBoolean()
  mentionable!: boolean;
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
}

export class UpdateMemberRolesDto {
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  roleIds!: string[];
}
