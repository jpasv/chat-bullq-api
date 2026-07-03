import { IsString, IsObject, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendMessagePublicDto {
  @ApiProperty({ example: 'conversation-id' })
  @IsString()
  conversationId: string;

  @ApiProperty({ enum: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT'] })
  @IsEnum(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT'])
  type: string;

  @ApiProperty({ example: { text: 'Olá!' } })
  @IsObject()
  content: Record<string, any>;

  @ApiPropertyOptional({ description: 'Id interno da Message respondida' })
  @IsOptional()
  @IsString()
  replyToMessageId?: string;
}
