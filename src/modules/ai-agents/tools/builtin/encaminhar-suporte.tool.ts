import { Injectable } from '@nestjs/common';
import { LeadOnboardingService } from '../../../lead-onboarding/lead-onboarding.service';
import { OnboardingMessengerService } from '../../../lead-onboarding/onboarding-messenger.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * Onboarding → suporte (Lívia). Padrão pedido pelo Tiago (18/10): toda demanda
 * de suporte vai pra Lívia, que devolve com handBackToOrchestrator quando
 * resolver; aí o agente de onboarding continua a qualificação.
 */
@Injectable()
export class EncaminharSuporteTool implements AiTool {
  readonly name = 'encaminharSuporte';
  readonly description =
    'Passa a conversa para a Lívia (suporte) resolver qualquer demanda de suporte: acesso, login, senha, curso ou bônus que não aparece, instalação, erro técnico, dúvida de uso do produto. Antes de chamar, avise o cliente em uma frase curta que vai ver isso com o suporte agora. A Lívia responde em seguida e devolve a conversa pra você quando resolver; aí você continua a qualificação. Não use para reembolso/cancelamento (isso é transferToHuman).';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['motivo'],
    properties: {
      motivo: {
        type: 'string',
        minLength: 5,
        maxLength: 300,
        description: 'Resumo da demanda de suporte para a Lívia (ex.: "curso não aparece na área de membros, e-mail fulano@x.com").',
      },
    },
  };

  constructor(
    private readonly onboarding: LeadOnboardingService,
    private readonly messenger: OnboardingMessengerService,
  ) {}

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const lead = await this.onboarding.findByConversation(ctx.conversationId);
    if (!lead) return { output: { ok: false, error: 'conversa_sem_lead' } };
    const motivo = String(input.motivo ?? '').trim();
    const supportAgentId = await this.messenger.delegateToSupport(ctx.conversationId, ctx.agentId);
    await this.onboarding.noteSupport(lead, motivo);
    return { output: { ok: true, delegatedTo: supportAgentId }, finalAction: 'DELEGATED' };
  }
}
