import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString } from 'class-validator';

export class UpsertIgFlowDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channelIds?: string[];

  @IsIn(['COMMENT', 'STORY_REPLY'])
  triggerType!: 'COMMENT' | 'STORY_REPLY';

  @IsOptional()
  @IsObject()
  triggerConfig?: Record<string, unknown>;

  @IsArray()
  nodes!: Record<string, unknown>[];

  @IsString()
  startNodeId!: string;

  @IsOptional()
  @IsInt()
  priority?: number;
}
