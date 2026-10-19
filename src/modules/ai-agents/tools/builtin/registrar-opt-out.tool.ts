import { Injectable } from '@nestjs/common';
import { LeadOnboardingService } from '../../../lead-onboarding/lead-onboarding.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/** Cliente pediu pra não receber mais mensagens: encerra cadência e bloqueia novos disparos. */
@Injectable()
export class RegistrarOptOutTool implements AiTool {
  readonly name = 'registrarOptOut';
  readonly description =
    'Use quando o cliente pedir para não receber mais mensagens ou recusar o diagnóstico de forma definitiva. Encerra todos os contatos automáticos deste fluxo (inclusive se a tag for colocada de novo) e registra no Hoppe. Depois responda só "Tudo bem, vou encerrar os contatos por aqui." ou equivalente.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['motivo'],
    properties: {
      motivo: { type: 'string', minLength: 3, maxLength: 300 },
    },
  };

  constructor(private readonly onboarding: LeadOnboardingService) {}

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const lead = await this.onboarding.findByConversation(ctx.conversationId);
    if (!lead) return { output: { ok: false, error: 'conversa_sem_lead' } };
    await this.onboarding.optOut(lead, String(input.motivo ?? '').trim() || 'sem motivo');
    return { output: { ok: true } };
  }
}
