import {
  IsString,
  IsOptional,
  IsObject,
  IsEnum,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class StartConversationContactDto {
  @ApiPropertyOptional({ example: '5511999999999' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'cliente@exemplo.com' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ example: 'João da Silva' })
  @IsOptional()
  @IsString()
  name?: string;
}

export class StartConversationMessageDto {
  @ApiProperty({ enum: ['TEXT', 'TEMPLATE'] })
  @IsEnum(['TEXT', 'TEMPLATE'])
  type: string;

  @ApiProperty({ example: { text: 'Olá! Tudo bem?' } })
  @IsObject()
  content: Record<string, any>;
}

export class StartConversationDto {
  @ApiProperty({ example: 'channel-id-here' })
  @IsString()
  channelId: string;

  @ApiProperty({ type: StartConversationContactDto })
  @ValidateNested()
  @Type(() => StartConversationContactDto)
  contact: StartConversationContactDto;

  /** Só relevante pra GMAIL — vira `Conversation.subject` (assunto do email). */
  @ApiPropertyOptional({ example: 'Sobre sua assinatura' })
  @IsOptional()
  @IsString()
  subject?: string;

  @ApiProperty({ type: StartConversationMessageDto })
  @ValidateNested()
  @Type(() => StartConversationMessageDto)
  message: StartConversationMessageDto;
}
