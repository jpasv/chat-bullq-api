import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateClientLogDto {
  @ApiProperty({ example: 'audio.upload_result' })
  @IsString()
  @MaxLength(80)
  event!: string;

  @ApiPropertyOptional({ example: 'status 400: Unsupported audio mime type' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  detail?: string;

  @ApiPropertyOptional({ description: 'Dados extras (versão do app, tamanho do arquivo...)' })
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}
