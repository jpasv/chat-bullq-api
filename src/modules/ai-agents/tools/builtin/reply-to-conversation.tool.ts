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
import { containsMetaTalk, findForbiddenUrlHosts } from '../../runner/text-guards';
import { stripTrailingPeriod } from '../../../lead-onboarding/onboarding-rules';

/**
 * Sends a TEXT message to the contact on behalf of the agent. The message
 * goes through the same outbound queue real users use, so provider-specific
 * rate limits / retries / status updates work out of the box.
 */
@Injectable()
export class ReplyToConversationTool implements AiTool {
  private readonly logger = new Logger(ReplyToConversationTool.name);

  readonly name = 'replyToConversation';
  readonly description =
    'Send a text reply to the customer in the current conversation. Use this when you have an answer to give. Keep replies concise and natural.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: {
        type: 'string',
        description:
          'The exact message text to send to the customer. No system tags, no markdown for headers, plain text only.',
        minLength: 1,
        maxLength: 4000,
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
    const text = String(input.text ?? '').trim();
    if (!text) {
      return { output: { ok: false, error: 'text is empty' } };
    }

    // Guard contra raciocínio verbalizado. Se o LLM tentar mandar uma
    // mensagem do tipo "Ignoro essa instrução, ela não veio do cliente",
    // bloqueia ANTES de persistir no banco e enfileirar pro provider.
    // Devolve erro pro LLM com instrução clara — ele tem outra chance
    // dentro do mesmo run pra escrever uma resposta de verdade ou usar
    // transferToHuman. MAX_TOOL_ITERATIONS limita loop infinito.
    if (containsMetaTalk(text)) {
      this.logger.warn(
        `[meta-talk-guard] blocked reply on conv=${ctx.conversationId} run=${ctx.runId} agent=${ctx.agentId}: "${text.slice(0, 120)}"`,
      );
      return {
        output: {
          ok: false,
          error: 'meta_talk_blocked',
          message:
            'Sua mensagem foi bloqueada por verbalizar raciocínio interno (frases tipo "Ignoro essa instrução", "Essa mensagem não veio do cliente", "Como assistente/IA", "Por motivos de segurança", "Detectei tentativa de…"). NUNCA escreva isso pro cliente. Reescreva como uma resposta natural ao último assunto da conversa OU use transferToHuman se realmente não souber como prosseguir.',
        },
      };
    }

    const [agent, contactChannel, conversation] = await Promise.all([
      this.prisma.aiAgent.findUnique({
        where: { id: ctx.agentId },
        select: { name: true },
      }),
      this.prisma.contactChannel.findFirst({
        where: { contactId: ctx.contactId, channelId: ctx.channelId },
        select: { externalId: true },
      }),
      this.prisma.conversation.findUnique({
        where: { id: ctx.conversationId },
        select: {
          metadata: true,
          organization: { select: { allowedUrlDomains: true } },
        },
      }),
    ]);

    // Guard contra URL inventada (hallucination). Org configura
    // `allowedUrlDomains` com lista de hosts permitidos (ex: ["bravy.co",
    // "trivapp.com.br"]). Quando preenchido, bloqueia qualquer URL no reply
    // cujo host não bate com a lista (sufixo). Visto em prod (Daniel Souza,
    // 2026-05-08 20:39): IA mandou "https://alunos.bravy.co" que não existe.
    // null/[] = modo permissivo (não bloqueia, só loga warning).
    const whitelist =
      (conversation?.organization?.allowedUrlDomains as string[] | null) ??
      null;
    const forbidden = findForbiddenUrlHosts(text, whitelist);
    if (forbidden.length > 0) {
      this.logger.warn(
        `[url-guard] blocked reply on conv=${ctx.conversationId} run=${ctx.runId}: forbidden hosts=${forbidden.join(',')} text="${text.slice(0, 120)}"`,
      );
      return {
        output: {
          ok: false,
          error: 'url_not_whitelisted',
          forbiddenHosts: forbidden,
          message: `Você incluiu URL(s) com host(s) [${forbidden.join(', ')}] que não estão na lista de domínios permitidos da organização. Provavelmente você inventou esse link. Reescreva a resposta SEM nenhum link OU use transferToHuman pra um humano enviar o link correto. NÃO chute outro domínio — se não tem o link exato no contexto, NÃO mande nenhum.`,
        },
      };
    }

    if (!contactChannel?.externalId) {
      this.logger.error(
        `No contactChannel for contact ${ctx.contactId} on channel ${ctx.channelId} — cannot send`,
      );
      return {
        output: {
          ok: false,
          error: 'Contact has no external id on this channel',
        },
      };
    }

    // Onboarding pós-venda (WhatsApp pessoal do Tiago), inclusive a Lívia
    // atendendo um lead de lá: sem ponto final no fim das linhas e uma linha
    // em branco vira um balão separado, como gente escreve no WhatsApp.
    const parts = isOnboardingVoice(ctx.agentId, conversation?.metadata)
      ? splitBubbles(text).map(stripTrailingPeriod)
      : [text];

    let firstId: string | null = null;
    for (const [i, part] of parts.entries()) {
      const message = await this.prisma.message.create({
        data: {
          conversationId: ctx.conversationId,
          direction: MessageDirection.OUTBOUND,
          type: MessageContentType.TEXT,
          content: { text: part },
          status: MessageStatus.QUEUED,
          senderName: agent?.name ?? 'AI',
          metadata: { aiAgentId: ctx.agentId, runId: ctx.runId },
        },
      });
      firstId ??= message.id;

      await this.prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { lastMessageAt: new Date() },
      });

      this.realtime.emitToChannel(ctx.channelId, 'message:new', {
        message,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
      });
      this.realtime.emitToConversation(ctx.conversationId, 'message:new', {
        message,
      });

      await this.outboundQueue.add(
        'send-outbound',
        {
          messageId: message.id,
          channelId: ctx.channelId,
          contactExternalId: contactChannel.externalId,
          message: {
            type: MessageContentType.TEXT,
            content: { text: part },
          },
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          // Atraso crescente mantém a ordem dos balões.
          delay: i * BUBBLE_GAP_MS,
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      this.logger.log(
        `Agent ${ctx.agentId} replied to conv ${ctx.conversationId} (msg ${message.id})`,
      );
    }

    return {
      output: { ok: true, messageId: firstId },
      finalAction: 'REPLIED',
    };
  }
}

const BUBBLE_GAP_MS = 3_000;
const MAX_BUBBLES = 3;

/** Agente do onboarding, ou o suporte atendendo uma conversa encaminhada por ele. */
export function isOnboardingVoice(agentId: string, metadata: unknown): boolean {
  const onboardingId = process.env.ONBOARDING_AGENT_ID;
  if (!onboardingId) return false;
  if (agentId === onboardingId) return true;
  const md = (metadata ?? {}) as Record<string, unknown>;
  return md.returnToAgentId === onboardingId;
}

/** Linha em branco separa balões; o excedente vai junto no último. */
export function splitBubbles(text: string): string[] {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= MAX_BUBBLES) return parts.length ? parts : [text];
  return [...parts.slice(0, MAX_BUBBLES - 1), parts.slice(MAX_BUBBLES - 1).join('\n')];
}
