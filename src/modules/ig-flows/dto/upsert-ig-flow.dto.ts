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

  // JSON livre como `unknown`: com enableImplicitConversion, um tipo
  // Record[] faz o class-transformer virar cada nó em Array (grava [[]]).
  // A forma é validada em ig-flows.validator.ts.
  @IsOptional()
  @IsObject()
  triggerConfig?: unknown;

  @IsArray()
  nodes!: unknown;

  @IsString()
  startNodeId!: string;

  @IsOptional()
  @IsInt()
  priority?: number;
}
