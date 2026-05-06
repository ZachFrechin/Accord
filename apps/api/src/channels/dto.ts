import { IsEnum, IsString, Length } from 'class-validator';
import { ChannelType } from '@discord2/shared';

export class CreateChannelDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsEnum(ChannelType)
  type!: typeof ChannelType.Text | typeof ChannelType.Voice;
}
