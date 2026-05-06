import { IsISO8601, IsOptional } from 'class-validator';

export class CreateInviteDto {
  @IsISO8601()
  @IsOptional()
  expiresAt?: string;
}
