import { IsOptional, IsString, IsUrl, Length, ValidateIf } from 'class-validator';

export class CreateServerDto {
  @IsString()
  @Length(1, 80)
  name!: string;
}

export class UpdateServerDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== null)
  @IsUrl({ require_tld: false })
  avatarUrl?: string | null;
}

export class BanServerMemberDto {
  @IsString()
  userId!: string;

  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @Length(0, 500)
  reason?: string | null;
}
