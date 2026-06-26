import { AiAgentKind } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAgentDto {
  @ApiProperty({ example: 'Atendente de Vendas' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiPropertyOptional({ enum: AiAgentKind, default: AiAgentKind.WORKER })
  @IsOptional()
  @IsEnum(AiAgentKind)
  kind?: AiAgentKind;

  @ApiPropertyOptional({ example: 'vendas' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['responde sobre planos', 'faz follow-up de orçamentos'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capabilities?: string[];

  @ApiProperty({ example: 'sakana/fugu-ultra-20260615' })
  @IsString()
  modelId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  modelParams?: Record<string, unknown>;

  @ApiProperty({ example: 'Você é um vendedor consultivo da Bravy School...' })
  @IsString()
  @MinLength(10)
  systemPrompt!: string;

  @ApiPropertyOptional({ default: 0.7 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({ default: 2048 })
  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(8192)
  maxTokens?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  canRespondDirectly?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // ─── Organograma matricial ágil ────────────────────────────

  @ApiPropertyOptional({
    description:
      'ID do agent ao qual este reporta (chefia direta). Null = raiz/CEO.',
  })
  @IsOptional()
  @IsString()
  parentAgentId?: string;

  @ApiPropertyOptional({
    description:
      'Departamento da empresa: VENDAS, SUPORTE, CS, CONTABIL, JURIDICO, FINANCEIRO, OPERACOES, TECNOLOGIA, MARKETING, OUTRO',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  department?: string;

  @ApiPropertyOptional({
    description: 'Squad ágil — time multi-funcional ortogonal ao departamento',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  squad?: string;

  @ApiPropertyOptional({
    description:
      'Contexto operacional vivo — atualizado quase diariamente pelo operador. Ex: "Hoje teve aula sobre Skills. Ofereça Dominando Claude Code R$ 1.497 (link X) pra quem responder feedback positivo." Injetado no system prompt em todo run.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  operationalContext?: string;
}
