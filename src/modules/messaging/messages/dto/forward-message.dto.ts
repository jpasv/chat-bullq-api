import {
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Número novo (contato sem histórico) pra onde encaminhar. Reaproveita o
 * fluxo de `startConversation` (resolveManual + resolveForOperator). Só canais
 * WhatsApp — o service valida `channelId` antes de resolver.
 */
export class ForwardTargetContactDto {
  @ApiProperty({ example: 'channel-id-here' })
  @IsString()
  channelId: string;

  @ApiProperty({ example: '5511999999999' })
  @IsString()
  phone: string;

  @ApiPropertyOptional({ example: 'João da Silva' })
  @IsOptional()
  @IsString()
  name?: string;
}

export class ForwardMessageDto {
  /**
   * Conversas WhatsApp já existentes (Zappfy/Official). O service valida
   * org/acesso e o tipo do canal de cada uma.
   */
  @ApiPropertyOptional({ type: [String], example: ['conversation-id-1'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  conversationIds?: string[];

  /**
   * Números novos pra iniciar conversa e já encaminhar. Pelo menos um entre
   * `conversationIds` e `contacts` precisa vir preenchido.
   */
  @ApiPropertyOptional({ type: [ForwardTargetContactDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ForwardTargetContactDto)
  contacts?: ForwardTargetContactDto[];
}
