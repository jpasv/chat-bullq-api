import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * ORCHESTRATOR-only. Silently hands the conversation over to a WORKER agent:
 *   1. flips `conversation.activeAgentId` to the worker;
 *   2. logs an AiAgentHandoff record + audit log;
 *   3. (almost never) sends a transition message — only when explicitly
 *      passed; default is silent so the customer doesn't see "vou te passar
 *      pra X" before X assumes anyway.
 *
 * After this tool runs, the auto-chain in AgentRunnerService picks up the
 * new active agent and fires the worker run immediately. The worker reads
 * the full history and responds directly — no introductory message needed.
 */
@Injectable()
export class DelegateToAgentTool implements AiTool {
  private readonly logger = new Logger(DelegateToAgentTool.name);

  readonly name = 'delegateToAgent';
  readonly description =
    'Encaminha a conversa pra um especialista. O handoff é SILENCIOSO por padrão — o worker assume e responde direto, sem você anunciar nada. NÃO use transitionMessage (deixa em branco). NÃO use replyToConversation antes pra dizer "vou te passar pra X" — isso é ruído, o cliente vê duas mensagens redundantes (sua "vou passar" + a do worker se apresentando). Só preencha transitionMessage em casos raros e específicos onde o cliente PRECISA saber da troca antes de receber a próxima resposta.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['agentId', 'reason'],
    properties: {
      agentId: {
        type: 'string',
        description:
          'O ID exato do agente especialista (vem da resposta de listAvailableAgents.agents[].agentId).',
      },
      reason: {
        type: 'string',
        description:
          'Por que esse worker? Uma frase curta. Ex: "Cliente perdeu acesso à área de membros".',
        maxLength: 300,
      },
      transitionMessage: {
        type: 'string',
        description:
          'OPCIONAL e desencorajado. Deixe vazio na maioria dos casos. Só use se o cliente realmente precisa saber da troca antes da próxima resposta.',
        maxLength: 600,
      },
      briefing: {
        type: 'string',
        description:
          'Resumo do contexto que você já levantou pra que o worker comece adiantado. Inclua o que o cliente disse, dores percebidas, info já coletada (email, telefone, etc). Texto corrido, sem markdown.',
        maxLength: 1500,
      },
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const targetAgentId = String(input.agentId ?? '').trim();
    const reason = String(input.reason ?? '').trim();
    const transitionMessage = input.transitionMessage
      ? String(input.transitionMessage).trim()
      : '';
    const briefing = input.briefing ? String(input.briefing).trim() : null;

    if (!targetAgentId) {
      return { output: { ok: false, error: 'agentId is required' } };
    }

    const target = await this.prisma.aiAgent.findFirst({
      where: {
        id: targetAgentId,
        organizationId: ctx.organizationId,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true, name: true, kind: true },
    });

    if (!target) {
      return {
        output: {
          ok: false,
          error: `Agent ${targetAgentId} not found in this organization or is inactive`,
        },
      };
    }

    if (target.kind !== 'WORKER') {
      return {
        output: {
          ok: false,
          error: `Cannot delegate to ${target.name}: only WORKER agents accept delegation.`,
        },
      };
    }

    const [fromAgent, contactChannel] = await Promise.all([
      this.prisma.aiAgent.findUnique({
        where: { id: ctx.agentId },
        select: { name: true },
      }),
      this.prisma.contactChannel.findFirst({
        where: { contactId: ctx.contactId, channelId: ctx.channelId },
        select: { externalId: true },
      }),
    ]);

    if (!contactChannel?.externalId) {
      return {
        output: {
          ok: false,
          error: 'Contact has no external id on this channel',
        },
      };
    }

    // Atomic: flip active agent + log handoff. Only emits a customer-visible
    // message when the orchestrator explicitly asked for one — silent
    // handoff is the default (worker assumes and replies directly, no
    // "vou te passar pra X" preamble).
    const txOps: any[] = [
      this.prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { activeAgentId: target.id, lastMessageAt: new Date() },
      }),
      this.prisma.aiAgentHandoff.create({
        data: {
          conversationId: ctx.conversationId,
          fromAgentId: ctx.agentId,
          toAgentId: target.id,
          reason,
          briefing,
        },
      }),
      this.prisma.conversationAuditLog.create({
        data: {
          conversationId: ctx.conversationId,
          actorId: null,
          action: 'AI_DELEGATED',
          metadata: {
            fromAgentId: ctx.agentId,
            toAgentId: target.id,
            reason,
            runId: ctx.runId,
            silent: !transitionMessage,
          },
        },
      }),
    ];
    if (transitionMessage) {
      txOps.unshift(
        this.prisma.message.create({
          data: {
            conversationId: ctx.conversationId,
            direction: MessageDirection.OUTBOUND,
            type: MessageContentType.TEXT,
            content: { text: transitionMessage },
            status: MessageStatus.QUEUED,
            senderName: fromAgent?.name ?? 'AI',
            metadata: {
              aiAgentId: ctx.agentId,
              runId: ctx.runId,
              handoffTransition: true,
            },
          },
        }),
      );
    }

    const txResult = await this.prisma.$transaction(txOps);
    const message = transitionMessage ? txResult[0] : null;

    // Realtime: always announce the delegation (so other UIs reflect the
    // active-agent flip), but only emit message:new when there's actually
    // a message to render.
    if (message) {
      this.realtime.emitToChannel(ctx.channelId, 'message:new', {
        message,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
      });
      this.realtime.emitToConversation(ctx.conversationId, 'message:new', {
        message,
      });
    }
    this.realtime.emitToConversation(
      ctx.conversationId,
      'conversation:ai-delegated',
      {
        conversationId: ctx.conversationId,
        toAgentId: target.id,
        toAgentName: target.name,
        reason,
      },
    );

    if (message) {
      await this.outboundQueue.add(
        'send-outbound',
        {
          messageId: message.id,
          channelId: ctx.channelId,
          contactExternalId: contactChannel.externalId,
          message: {
            type: MessageContentType.TEXT,
            content: { text: transitionMessage },
          },
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    this.logger.log(
      `Orchestrator ${ctx.agentId} delegated conv ${ctx.conversationId} → ${target.name} (${target.id})${transitionMessage ? '' : ' [silent]'}: ${reason}`,
    );

    return {
      output: {
        ok: true,
        delegatedTo: { agentId: target.id, name: target.name },
        ...(message ? { transitionMessageId: message.id } : {}),
        silent: !transitionMessage,
        message: transitionMessage
          ? 'Delegação concluída com mensagem de transição. Worker assume em sequência.'
          : 'Delegação silenciosa concluída — worker assume e responde direto, sem mensagem de transição.',
      },
      finalAction: 'DELEGATED',
    };
  }
}
