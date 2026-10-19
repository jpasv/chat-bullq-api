import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import axios from 'axios';
import {
  ConversationStatus,
  MessageContentType,
  MessageDirection,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { LeadOnboardingConfigService } from './lead-onboarding-config.service';
import { ATTEMPT_MESSAGE_SOURCE, SUPPORT_RETURN_NOTE } from './lead-onboarding.constants';

/** O 1258 é o WhatsApp pessoal do Tiago: conversa em andamento com ele não é nossa. */
export class HumanConversationError extends Error {
  constructor(readonly conversationId: string) {
    super(`conversa existente com humano: ${conversationId}`);
  }
}

export interface WhatsAppTarget {
  /** Dígitos do JID real (ex.: 554791210077 — sem o 9º dígito em contas antigas). */
  digits: string;
  jid: string;
}

const OPEN_STATUSES = [
  ConversationStatus.PENDING,
  ConversationStatus.OPEN,
  ConversationStatus.BOT,
  ConversationStatus.WAITING,
];

const HUMAN_LOOKBACK_DAYS = 30;

/**
 * Envio proativo das tentativas no canal Zappfy do onboarding. Mesmo caminho
 * do RecoveryOutreachService (Contact + ContactChannel + Conversation +
 * fila `outbound-messages`), com duas diferenças que importam no WhatsApp
 * pessoal do Tiago:
 *   1. o JID vem do `/chat/check` do Zappfy, não do telefone do formulário —
 *      senão a resposta do lead chega por outro JID e cai noutra conversa;
 *   2. nunca sequestra conversa com histórico recente (o Tiago já fala com
 *      a pessoa) — lança HumanConversationError e o lead é pulado.
 */
@Injectable()
export class OnboardingMessengerService {
  private readonly logger = new Logger(OnboardingMessengerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly config: LeadOnboardingConfigService,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  /** JID real do número no WhatsApp, ou null se o número não tem WhatsApp. */
  async resolveTarget(phone: string): Promise<WhatsAppTarget | null> {
    const token = await this.channelToken();
    const resp = await axios.post(
      'https://api.zappfy.io/chat/check',
      { numbers: [phone] },
      { headers: { token }, timeout: 15_000 },
    );
    const hit = (Array.isArray(resp.data) ? resp.data : [])[0];
    if (!hit?.isInWhatsapp || typeof hit.jid !== 'string') return null;
    const jid = hit.jid as string;
    return { jid, digits: jid.split('@')[0] };
  }

  /**
   * Envia `text` pro lead. Sem `conversationId` (1ª tentativa), resolve contato
   * e conversa e recusa conversa com histórico humano recente.
   */
  async send(params: {
    target: WhatsAppTarget;
    name: string | null;
    email: string | null;
    text: string;
    conversationId?: string | null;
  }): Promise<{ conversationId: string; contactId: string }> {
    const organizationId = this.requireConfig('orgId');
    const channelId = this.requireConfig('channelId');
    const contactId = await this.resolveContact(organizationId, channelId, params);

    const conversationId =
      params.conversationId ??
      (await this.ensureConversation(organizationId, channelId, contactId));

    await this.enqueue(channelId, contactId, conversationId, params.target.jid, params.text);
    return { conversationId, contactId };
  }

  /** Grava o bloco "Contexto do lead" lido pelo prompt-builder. */
  async setPromptContext(conversationId: string, promptContext: string): Promise<void> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    const metadata = { ...((conv?.metadata as Record<string, unknown>) ?? {}), promptContext };
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { metadata: metadata as Prisma.InputJsonValue },
    });
  }

  /**
   * Checagem antes das tentativas 2/3 e da retomada, sem depender só do hook
   * de inbound (fire-and-forget): 'replied' se o lead escreveu depois de
   * `since`; 'human' se a IA foi desligada, a conversa foi atribuída a alguém
   * ou o agente ativo mudou; null se pode enviar.
   */
  async conversationGuard(
    conversationId: string,
    since: Date | null,
  ): Promise<'replied' | 'human' | 'support' | null> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { aiEnabled: true, assignedToId: true, activeAgentId: true },
    });
    if (!conv) return 'human';
    if (conv.activeAgentId === this.config.supportAgentId && conv.aiEnabled !== false && !conv.assignedToId) {
      return 'support';
    }
    if (conv.aiEnabled === false || conv.assignedToId || conv.activeAgentId !== this.config.agentId) {
      return 'human';
    }
    if (since) {
      const inbound = await this.prisma.message.findFirst({
        where: { conversationId, direction: MessageDirection.INBOUND, createdAt: { gt: since } },
        select: { id: true },
      });
      if (inbound) return 'replied';
    }
    return null;
  }

  /**
   * Pode mandar retomada pra quem parou de responder na qualificação?
   * 'human' = IA desligada, conversa atribuída, outro agente ou aprovação
   * pendente; 'owes_reply' = a última mensagem é do lead (alguém deve a
   * resposta, não o lead); null = a bola está com o lead.
   */
  async followupGuard(conversationId: string): Promise<'human' | 'owes_reply' | null> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { aiEnabled: true, assignedToId: true, activeAgentId: true },
    });
    if (!conv || conv.aiEnabled === false || conv.assignedToId) return 'human';
    if (conv.activeAgentId !== this.config.agentId && conv.activeAgentId !== this.config.supportAgentId) {
      return 'human';
    }
    const pending = await this.prisma.aiPendingAction.findFirst({
      where: { conversationId, status: 'PENDING' },
      select: { id: true },
    });
    if (pending) return 'human';
    const last = await this.prisma.message.findFirst({
      where: { conversationId, type: { not: 'SYSTEM' } },
      orderBy: { createdAt: 'desc' },
      select: { direction: true },
    });
    if (last?.direction === MessageDirection.INBOUND) return 'owes_reply';
    return null;
  }

  /**
   * Passa a conversa pro agente de suporte e marca pra quem devolver. A nota
   * no promptContext diz ao suporte pra devolver quando terminar.
   */
  async delegateToSupport(conversationId: string, fromAgentId: string): Promise<string> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    const md = { ...((conv?.metadata as Record<string, any>) ?? {}) };
    const base = typeof md.promptContext === 'string' ? md.promptContext : '';
    md.promptContext = base.includes(SUPPORT_RETURN_NOTE) ? base : `${base}\n\n${SUPPORT_RETURN_NOTE}`.trim();
    md.returnToAgentId = fromAgentId;
    const supportAgentId = this.config.supportAgentId;
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { activeAgentId: supportAgentId, aiEnabled: true, metadata: md as Prisma.InputJsonValue },
    });
    return supportAgentId;
  }

  /**
   * Volta do suporte: se a conversa foi encaminhada pelo onboarding, devolve o
   * agente de origem e limpa a marcação. Null = conversa não é do onboarding.
   */
  async returnFromSupport(conversationId: string): Promise<string | null> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    const md = { ...((conv?.metadata as Record<string, any>) ?? {}) };
    const target = typeof md.returnToAgentId === 'string' ? md.returnToAgentId : null;
    if (!target) return null;
    delete md.returnToAgentId;
    if (typeof md.promptContext === 'string') {
      md.promptContext = md.promptContext.replace(SUPPORT_RETURN_NOTE, '').trim();
    }
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { activeAgentId: target, metadata: md as Prisma.InputJsonValue },
    });
    return target;
  }

  /** Humano assumiu: desliga a IA só nesta conversa. */
  async pauseConversation(conversationId: string): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { aiEnabled: false },
    });
  }

  /**
   * A eco que chegou é de uma mensagem que o próprio sistema (tentativa ou IA)
   * criou há pouco? Compara o texto com os OUTBOUND recentes da conversa.
   */
  async hasRecentSystemOutbound(
    conversationId: string,
    text: string | null,
    windowMs = 3 * 60 * 1000,
  ): Promise<boolean> {
    const recent = await this.prisma.message.findMany({
      where: {
        conversationId,
        direction: MessageDirection.OUTBOUND,
        createdAt: { gte: new Date(Date.now() - windowMs) },
      },
      select: { content: true, metadata: true },
      take: 20,
    });
    const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    return recent.some((m) => {
      const md = (m.metadata ?? {}) as Record<string, unknown>;
      const fromSystem = md.source === ATTEMPT_MESSAGE_SOURCE || !!md.aiAgentId;
      return fromSystem && norm((m.content as any)?.text) === norm(text);
    });
  }

  private async resolveContact(
    organizationId: string,
    channelId: string,
    params: { target: WhatsAppTarget; name: string | null; email: string | null },
  ): Promise<string> {
    const externalId = params.target.jid;
    const linked = await this.prisma.contactChannel.findUnique({
      where: { uq_contact_channel_external: { channelId, externalId } },
      select: { contactId: true },
    });
    if (linked) return linked.contactId;

    const phone = params.target.digits;
    const existing = await this.prisma.contact.findFirst({
      where: { organizationId, phone, deletedAt: null },
      select: { id: true },
    });
    try {
      if (existing) {
        await this.prisma.contactChannel.create({
          data: { contactId: existing.id, channelId, externalId, profileName: params.name ?? undefined },
        });
        return existing.id;
      }
      const contact = await this.prisma.contact.create({
        data: {
          organizationId,
          name: params.name ?? undefined,
          phone,
          email: params.email ?? undefined,
          channels: { create: { channelId, externalId, profileName: params.name ?? undefined } },
        },
        select: { id: true },
      });
      return contact.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const racer = await this.prisma.contactChannel.findUnique({
          where: { uq_contact_channel_external: { channelId, externalId } },
          select: { contactId: true },
        });
        if (racer) return racer.contactId;
      }
      throw err;
    }
  }

  private async ensureConversation(
    organizationId: string,
    channelId: string,
    contactId: string,
  ): Promise<string> {
    // SQL cru de propósito: o filtro JSON do Prisma (`NOT {metadata: {path,
    // equals}}`) descarta linhas SEM `source` (NULL), que são justamente as
    // mensagens normais — a guarda nunca disparava.
    const since = new Date(Date.now() - HUMAN_LOOKBACK_DAYS * 24 * 3600 * 1000);
    const rows = await this.prisma.$queryRaw<Array<{ conversation_id: string }>>`
      SELECT m.conversation_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.channel_id = ${channelId}
        AND c.contact_id = ${contactId}
        AND m.created_at >= ${since}
        AND m.type::text <> 'SYSTEM'
        AND (m.metadata->>'source') IS DISTINCT FROM ${ATTEMPT_MESSAGE_SOURCE}
      LIMIT 1
    `;
    if (rows.length > 0) throw new HumanConversationError(rows[0].conversation_id);

    const agentId = this.requireConfig('agentId');
    const open = await this.prisma.conversation.findFirst({
      where: { organizationId, channelId, contactId, status: { in: OPEN_STATUSES } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, assignedToId: true },
    });
    if (open?.assignedToId) throw new HumanConversationError(open.id);
    if (open) {
      await this.prisma.conversation.update({
        where: { id: open.id },
        data: { status: ConversationStatus.BOT, aiEnabled: true, activeAgentId: agentId },
      });
      return open.id;
    }

    const conversation = await this.prisma.conversation.create({
      data: {
        organizationId,
        channelId,
        contactId,
        status: ConversationStatus.BOT,
        aiEnabled: true,
        protocol: this.generateProtocol(),
        isGroup: false,
        activeAgentId: agentId,
      },
      select: { id: true },
    });
    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: conversation.id,
        action: 'CREATED',
        toValue: ConversationStatus.BOT,
        metadata: { trigger: 'lead_onboarding' },
      },
    });
    return conversation.id;
  }

  private async enqueue(
    channelId: string,
    contactId: string,
    conversationId: string,
    externalId: string,
    text: string,
  ): Promise<void> {
    const content = { text };
    const message = await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.OUTBOUND,
        type: MessageContentType.TEXT,
        content,
        status: MessageStatus.QUEUED,
        senderName: 'Assistente do Tiago',
        metadata: { source: ATTEMPT_MESSAGE_SOURCE },
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });
    this.realtime.emitToChannel(channelId, 'message:new', { message, conversationId, contactId });
    this.realtime.emitToConversation(conversationId, 'message:new', { message });
    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId,
        contactExternalId: externalId,
        message: { type: MessageContentType.TEXT, content },
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: false },
    );
    this.logger.log(`Onboarding: mensagem enfileirada conv=${conversationId}`);
  }

  private async channelToken(): Promise<string> {
    const channelId = this.requireConfig('channelId');
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { config: true },
    });
    const token = (channel?.config as Record<string, any> | null)?.token;
    if (!token) throw new Error(`Canal ${channelId} sem token Zappfy`);
    return token;
  }

  private requireConfig(key: 'orgId' | 'channelId' | 'agentId'): string {
    const v = this.config[key];
    if (!v) throw new Error(`Onboarding sem ${key} configurado`);
    return v;
  }

  private generateProtocol(): string {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${date}-${rand}`;
  }
}
