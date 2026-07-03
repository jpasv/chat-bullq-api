import { IsUrl, IsArray, IsEnum, ArrayNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AutomationTrigger } from '@prisma/client';

export class CreateWebhookPublicDto {
  @ApiProperty({ example: 'https://meu-sistema.com/webhooks/bullq' })
  @IsUrl({ require_tld: false })
  url: string;

  @ApiProperty({ enum: AutomationTrigger, isArray: true, example: ['MESSAGE_RECEIVED'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(AutomationTrigger, { each: true })
  events: AutomationTrigger[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}
