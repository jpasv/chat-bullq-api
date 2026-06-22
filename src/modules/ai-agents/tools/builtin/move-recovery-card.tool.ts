import { Injectable, Logger } from '@nestjs/common';
import { SalesRecoveryService } from '../../../sales-recovery/sales-recovery.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

const ALLOWED_STAGES = ['in_contact', 'follow_up', 'lost'] as const;
type AllowedStage = (typeof ALLOWED_STAGES)[number];

/**
 * Permite ao agente de recuperação mover o card da conversa atual no pipeline
 * de Recuperação de Vendas — ex.: lead recusou → "lost"; pediu pra falar depois
 * → "follow_up". As transições de "ganho"/"reembolsado" NÃO ficam aqui: são
 * determinísticas via webhook da Kirvano (fonte da verdade do pagamento).
 */
@Injectable()
export class MoveRecoveryCardTool implements AiTool {
  private readonly logger = new Logger(MoveRecoveryCardTool.name);

  readonly name = 'moveRecoveryCard';
  readonly description =
    'Move o card desta conversa no funil de recuperação de vendas. Use "in_contact" quando o lead está conversando, "follow_up" quando ficou de retornar/pensar, e "lost" quando recusou claramente. Não use para vendas fechadas — isso é automático pelo pagamento.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['stageKey'],
    properties: {
      stageKey: {
        type: 'string',
        enum: [...ALLOWED_STAGES],
        description: 'Estágio destino: in_contact | follow_up | lost.',
      },
      reason: {
        type: 'string',
        description: 'Motivo curto da mudança (opcional, fica no histórico).',
        maxLength: 280,
      },
    },
  };

  constructor(private readonly recovery: SalesRecoveryService) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const stageKey = String(input.stageKey ?? '') as AllowedStage;
    if (!ALLOWED_STAGES.includes(stageKey)) {
      return {
        output: { ok: false, error: 'stageKey inválido', allowed: ALLOWED_STAGES },
      };
    }

    const result = await this.recovery.moveCardByConversation(
      ctx.conversationId,
      stageKey,
    );
    if (result.ok) {
      this.logger.log(
        `IA moveu card → ${stageKey} (conv=${ctx.conversationId})`,
      );
    }
    return { output: { ...result, stageKey } };
  }
}
