import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Atualização dos dados do Projeto de um grupo. Todos os campos opcionais:
 * só os enviados são alterados. `metadata` é mesclado (não substitui o objeto
 * inteiro) — é por onde entram os campos futuros sem mudar o backend.
 * String vazia em hoppeId/responsibleUserId/status limpa o valor.
 */
export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  hoppeId?: string;

  @IsOptional()
  @IsString()
  responsibleUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  status?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
