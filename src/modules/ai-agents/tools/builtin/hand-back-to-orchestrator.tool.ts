import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
import { OnboardingMessengerService } from '../../../lead-onboarding/onboarding-messenger.service';

/**
 * WORKER-only. Returns the conversation to the orchestrator — typically when
 * the customer changes subject to a domain this worker doesn't cover.
 * Clears `activeAgentId` so the next inbound message routes back to the
 * channel's default orchestrator.
 */
@Injectable()
export class HandBackToOrchestratorTool implements AiTool {
  private readonly logger = new Logger(HandBackToOrchestratorTool.name);

  readonly name = 'handBackToOrchestrator';
  readonly description =
    'Devolve a conversa para o orquestrador. Use quando o cliente mudar de assunto para um domínio fora da sua especialidade. O orquestrador vai decidir pra qual outro especialista encaminhar.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: {
        type: 'string',
        description:
          'Por que está devolvendo. Ex: "Cliente passou a perguntar sobre questões jurídicas, fora do meu escopo de contabilidade".',
        minLength: 5,
        maxLength: 300,
      },
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly onboardingMessenger: OnboardingMessengerService,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const reason = String(input.reason ?? '').trim();

    // Conversa encaminhada pelo onboarding pós-venda (suporte → Lívia): volta
    // pro agente de onboarding continuar a qualificação, não pro orquestrador.
    const returnedTo = await this.onboardingMessenger.returnFromSupport(ctx.conversationId);
    if (returnedTo) {
      await this.prisma.conversationAuditLog.create({
        data: {
          conversationId: ctx.conversationId,
          actorId: null,
          action: 'AI_HANDED_BACK',
          metadata: { fromAgentId: ctx.agentId, toAgentId: returnedTo, reason, runId: ctx.runId },
        },
      });
      this.logger.log(`Suporte ${ctx.agentId} devolveu conv ${ctx.conversationId} pro onboarding (${returnedTo}): ${reason}`);
      return {
        output: { ok: true, returnedTo, message: 'Conversa devolvida ao agente de onboarding, que continua no próximo turno.' },
        finalAction: 'HANDED_BACK',
      };
    }

    await this.prisma.$transaction([
      this.prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { activeAgentId: null },
      }),
      this.prisma.aiAgentHandoff.create({
        data: {
          conversationId: ctx.conversationId,
          fromAgentId: ctx.agentId,
          // Orchestrator slot — we don't know which orchestrator will pick up
          // (channel might have multiple over time), so we point this at the
          // current worker's organization-level "fall back" by leaving toAgentId
          // pointing at the same agent and using metadata. Trick: point to self
          // and let the audit log carry the real semantic.
          toAgentId: ctx.agentId,
          reason,
        },
      }),
      this.prisma.conversationAuditLog.create({
        data: {
          conversationId: ctx.conversationId,
          actorId: null,
          action: 'AI_HANDED_BACK',
          metadata: { fromAgentId: ctx.agentId, reason, runId: ctx.runId },
        },
      }),
    ]);

    this.realtime.emitToConversation(
      ctx.conversationId,
      'conversation:ai-handed-back',
      { conversationId: ctx.conversationId, fromAgentId: ctx.agentId, reason },
    );

    this.logger.log(
      `Worker ${ctx.agentId} handed conv ${ctx.conversationId} back to orchestrator: ${reason}`,
    );

    return {
      output: {
        ok: true,
        message:
          'Devolvido ao orquestrador. A próxima mensagem do cliente vai cair no fluxo de roteamento.',
      },
      finalAction: 'HANDED_BACK',
    };
  }
}
