import { IsUrl, IsArray, IsEnum, IsOptional, IsString, IsBoolean, ArrayNotEmpty } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AutomationTrigger } from '@prisma/client';

export class UpdateWebhookPublicDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  @ApiPropertyOptional({ enum: AutomationTrigger, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(AutomationTrigger, { each: true })
  events?: AutomationTrigger[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}
