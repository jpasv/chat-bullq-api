import { IsString, IsOptional, IsObject, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendMessageDto {
  @ApiProperty({ example: 'conversation-id-here' })
  @IsString()
  conversationId: string;

  @ApiProperty({ enum: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'TEMPLATE'] })
  @IsEnum(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'TEMPLATE'])
  type: string;

  @ApiProperty({ example: { text: 'Hello!' } })
  @IsObject()
  content: Record<string, any>;

  /**
   * Path 1 — UI envia o id INTERNO da Message que está sendo respondida.
   * O service resolve pra externalId no banco (necessário pra Cloud API,
   * Uazapi e Instagram que usam IDs externos do provider).
   */
  @ApiPropertyOptional({ description: 'ID interno da Message que está sendo respondida' })
  @IsOptional()
  @IsString()
  replyToMessageId?: string;

  /**
   * Path 2 — chamadas server-to-server (replay, automação) que já têm
   * o externalMessageId em mãos.
   */
  @ApiPropertyOptional({ example: { externalMessageId: 'msg-id' } })
  @IsOptional()
  @IsObject()
  replyTo?: { externalMessageId: string };
}
