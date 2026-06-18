import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateSegmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** Canais (instâncias) membros do segmento. Compartilham os grupos. */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  channelIds!: string[];

  /** Canal principal — por onde as respostas de grupo são enviadas. */
  @IsOptional()
  @IsString()
  primaryChannelId?: string;
}

export class UpdateSegmentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetSegmentChannelsDto {
  @IsArray()
  @IsString({ each: true })
  channelIds!: string[];
}

export class SetPrimaryChannelDto {
  @IsString()
  primaryChannelId!: string;
}
