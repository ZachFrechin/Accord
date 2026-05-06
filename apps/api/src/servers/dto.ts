import { IsString, Length } from 'class-validator';

export class CreateServerDto {
  @IsString()
  @Length(1, 80)
  name!: string;
}
