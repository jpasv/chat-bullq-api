import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../database/prisma.module';
import { LlmModule } from '../llm/llm.module';
import { ToolsModule } from '../tools/tools.module';
import { PromptsModule } from '../prompts/prompts.module';
import { EvalRunnerService } from './runner.service';
import { JudgeService } from './judge.service';
import { EvalReporterService } from './reporter.service';
import { EvalsController } from './evals.controller';

/**
 * Sistema de evals (testes automatizados de prompt) dos agents de IA.
 * Roda casos declarativos contra um agent, valida tool calls + conteúdo
 * + final action, e usa um LLM-as-judge (Haiku) para asserções subjetivas.
 *
 * O runner carrega o agent + skills do DB, monta o prompt via PromptComposer,
 * chama o LlmService com tools (built-in + custom skills) e CAPTURA os
 * tool_calls retornados — sem executar nenhuma side-effect (não envia
 * mensagem real, não persiste no banco). Isso evita acoplar evals ao
 * AiAgentRunnerService completo.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    LlmModule,
    ToolsModule,
    PromptsModule,
  ],
  controllers: [EvalsController],
  providers: [EvalRunnerService, JudgeService, EvalReporterService],
  exports: [EvalRunnerService, JudgeService, EvalReporterService],
})
export class EvalsModule {}
