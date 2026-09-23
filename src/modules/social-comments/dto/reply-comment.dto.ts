import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ReplyCommentDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(2200) text: string;
}
