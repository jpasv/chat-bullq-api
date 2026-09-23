import { IsOptional, IsString, IsEnum, IsBooleanString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { SocialCommentStatus } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListCommentsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() channelId?: string;
  @ApiPropertyOptional({ enum: SocialCommentStatus }) @IsOptional() @IsEnum(SocialCommentStatus) status?: SocialCommentStatus;
  @ApiPropertyOptional({ description: '"true" = só raízes sem resposta' }) @IsOptional() @IsBooleanString() unreplied?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 30 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
