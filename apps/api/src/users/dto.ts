import { IsString, IsUrl, Length, ValidateIf } from 'class-validator';

export class UpdateProfileDto {
  @IsString()
  @Length(1, 40)
  displayName!: string;

  @ValidateIf((_, value: unknown) => value !== null)
  @IsUrl({ require_tld: false })
  avatarUrl!: string | null;
}
