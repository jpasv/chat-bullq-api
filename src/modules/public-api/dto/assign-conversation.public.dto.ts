import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class AssignConversationPublicDto {
  @ApiPropertyOptional({ description: 'Id do usuário responsável' })
  @IsOptional()
  @IsString()
  assignedToId?: string;

  @ApiPropertyOptional({ description: 'Id do setor/departamento' })
  @IsOptional()
  @IsString()
  departmentId?: string;
}
