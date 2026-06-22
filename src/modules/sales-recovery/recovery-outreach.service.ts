import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ConversationStatus,
  MessageContentType,
  MessageDirection,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { RecoveryConfigService } from './recovery-config.service';

export interface ResolvedRecoveryContact {
  contactId: string;
  externalId: string; // "<phone>@s.whatsapp.net"
}

interface OpenerVars {
  nome: string;
  produto: string;
  link: string;
}

/**
 * Cold outreach: cria/garante Contact + ContactChannel + Conversation a partir
 * do telefone que veio da Kirvano (o lead pode nunca ter falado com a gente) e
 * dispara a 1ª mensagem proativa pela MESMA fila `outbound-messages` que o resto
 * do sistema usa. A partir da resposta do lead, o agente de recuperação assume
 * pelo pipeline normal de inbound (via AiAgentChannel no canal de outreach).
 *
 * Replica a lógica essencial de ContactResolverService/ConversationResolverService
 * (sem importar MessagingModule, pra evitar ciclo com o hook de inbound).
 */
@Injectable()
export class RecoveryOutreachService {
  private readonly logger = new Logger(RecoveryOutreachService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly config: RecoveryConfigService,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  /** WhatsApp JID individual usado como external_id (padrão Zappfy). */
  static toExternalId(phone: string): string {
    return `${phone}@s.whatsapp.net`;
  }

  /**
   * Acha/cria o contato pelo telefone e garante o vínculo no canal de outreach.
   * Tenta casar com um Contact existente (mesmo telefone) antes de criar.
   */
  async resolveContact(
    organizationId: string,
    channelId: string,
    data: { phone: string; name?: string | null; email?: string | null },
  ): Promise<ResolvedRecoveryContact> {
    const externalId = RecoveryOutreachService.toExternalId(data.phone);

    // 1. Já existe vínculo nesse canal?
    const existingChannel = await this.prisma.contactChannel.findUnique({
      where: { uq_contact_channel_external: { channelId, externalId } },
      select: { contactId: true },
    });
    if (existingChannel) {
      return { contactId: existingChannel.contactId, externalId };
    }

    // 2. Existe um Contact com esse telefone (de outro canal)? Reaproveita.
    const existingContact = await this.prisma.contact.findFirst({
      where: { organizationId, phone: data.phone, deletedAt: null },
      select: { id: true, name: true },
    });

    try {
      if (existingContact) {
        await this.prisma.contactChannel.create({
          data: {
            contactId: existingContact.id,
            channelId,
            externalId,
            profileName: data.name ?? undefined,
          },
        });
        return { contactId: existingContact.id, externalId };
      }

      const contact = await this.prisma.contact.create({
        data: {
          organizationId,
          name: data.name ?? undefined,
          phone: data.phone,
          email: data.email ?? undefined,
          channels: {
            create: { channelId, externalId, profileName: data.name ?? undefined },
          },
        },
        select: { id: true },
      });
      this.logger.log(`Recovery contact criado: ${contact.id} (${data.phone})`);
      return { contactId: contact.id, externalId };
    } catch (err) {
      // Corrida: outro webhook criou o vínculo no meio. Re-busca.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const racer = await this.prisma.contactChannel.findUnique({
          where: { uq_contact_channel_external: { channelId, externalId } },
          select: { contactId: true },
        });
        if (racer) return { contactId: racer.contactId, externalId };
      }
      throw err;
    }
  }

  /**
   * Garante uma conversa aberta no canal de outreach (status BOT, dona do
   * agente de recuperação) e envia a 1ª mensagem proativa. Retorna o id da
   * conversa e se a mensagem foi enfileirada.
   */
  async sendOpener(params: {
    organizationId: string;
    channelId: string;
    contactId: string;
    externalId: string;
    vars: OpenerVars;
    agentId?: string | null;
  }): Promise<{ conversationId: string; sent: boolean }> {
    const { organizationId, channelId, contactId, externalId, vars, agentId } =
      params;

    const conversationId = await this.ensureConversation(
      organizationId,
      channelId,
      contactId,
      agentId ?? null,
    );

    const text = this.render(this.config.openerTemplate, vars);
    await this.enqueueText({
      organizationId,
      channelId,
      contactId,
      conversationId,
      externalId,
      text,
      source: 'sales_recovery_outreach',
    });
    this.logger.log(`Opener de recuperação enfileirado: conv=${conversationId}`);
    return { conversationId, sent: true };
  }

  /**
   * Envia um follow-up (lembrete) numa conversa de recuperação já existente.
   * Garante a conversa se ela não existir mais.
   */
  async sendFollowUp(params: {
    organizationId: string;
    channelId: string;
    contactId: string;
    externalId: string;
    conversationId: string | null;
    vars: OpenerVars;
    agentId?: string | null;
  }): Promise<{ conversationId: string; sent: boolean }> {
    const conversationId =
      params.conversationId ??
      (await this.ensureConversation(
        params.organizationId,
        params.channelId,
        params.contactId,
        params.agentId ?? null,
      ));

    const text = this.render(this.config.followUpTemplate, params.vars);
    await this.enqueueText({
      organizationId: params.organizationId,
      channelId: params.channelId,
      contactId: params.contactId,
      conversationId,
      externalId: params.externalId,
      text,
      source: 'sales_recovery_followup',
    });
    this.logger.log(`Follow-up de recuperação enfileirado: conv=${conversationId}`);
    return { conversationId, sent: true };
  }

  private async enqueueText(params: {
    organizationId: string;
    channelId: string;
    contactId: string;
    conversationId: string;
    externalId: string;
    text: string;
    source: string;
  }): Promise<void> {
    const { channelId, contactId, conversationId, externalId, text, source } =
      params;

    const message = await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.OUTBOUND,
        type: MessageContentType.TEXT,
        content: { text },
        status: MessageStatus.QUEUED,
        senderName: 'Recuperação',
        metadata: { source },
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });

    this.realtime.emitToChannel(channelId, 'message:new', {
      message,
      conversationId,
      contactId,
    });
    this.realtime.emitToConversation(conversationId, 'message:new', { message });

    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId,
        contactExternalId: externalId,
        message: { type: MessageContentType.TEXT, content: { text } },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  private async ensureConversation(
    organizationId: string,
    channelId: string,
    contactId: string,
    agentId: string | null,
  ): Promise<string> {
    const open = await this.prisma.conversation.findFirst({
      where: {
        organizationId,
        channelId,
        contactId,
        status: {
          in: [
            ConversationStatus.PENDING,
            ConversationStatus.OPEN,
            ConversationStatus.BOT,
            ConversationStatus.WAITING,
          ],
        },
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (open) {
      if (agentId) {
        await this.prisma.conversation.update({
          where: { id: open.id },
          data: { activeAgentId: agentId },
        });
      }
      return open.id;
    }

    const protocol = this.generateProtocol();
    const conversation = await this.prisma.conversation.create({
      data: {
        organizationId,
        channelId,
        contactId,
        status: ConversationStatus.BOT,
        protocol,
        isGroup: false,
        activeAgentId: agentId ?? undefined,
      },
      select: { id: true },
    });
    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: conversation.id,
        action: 'CREATED',
        toValue: ConversationStatus.BOT,
        metadata: { trigger: 'sales_recovery_outreach' },
      },
    });
    return conversation.id;
  }

  private render(template: string, vars: OpenerVars): string {
    return template
      .replace(/\{nome\}/g, vars.nome || 'tudo bem?')
      .replace(/\{produto\}/g, vars.produto || 'o produto')
      .replace(/\{link\}/g, vars.link || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private generateProtocol(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${date}-${rand}`;
  }
}
