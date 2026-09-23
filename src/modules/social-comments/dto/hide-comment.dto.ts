import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class HideCommentDto {
  @ApiProperty() @IsBoolean() hidden: boolean;
}
