import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ChannelType,
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
  externalId: string; // Zappfy: "<phone>@s.whatsapp.net" · Oficial: "<phone>"
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

  /**
   * external_id no formato que cada canal usa: Zappfy/baileys usa o JID
   * (`<phone>@s.whatsapp.net`); WhatsApp Oficial (Meta) e demais usam só os
   * dígitos. Tem que bater com o que o inbound grava, senão duplica contato.
   */
  private async toExternalId(channelId: string, phone: string): Promise<string> {
    const type = await this.getChannelType(channelId);
    return type === ChannelType.WHATSAPP_ZAPPFY
      ? `${phone}@s.whatsapp.net`
      : phone;
  }

  private async getChannelType(channelId: string): Promise<ChannelType | null> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { type: true },
    });
    return channel?.type ?? null;
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
    const externalId = await this.toExternalId(channelId, data.phone);

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

    const sent = await this.enqueue({
      organizationId,
      channelId,
      contactId,
      conversationId,
      externalId,
      vars,
      templateName: this.config.openerTemplateName,
      textTemplate: this.config.openerTemplate,
      source: 'sales_recovery_outreach',
    });
    return { conversationId, sent };
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

    const sent = await this.enqueue({
      organizationId: params.organizationId,
      channelId: params.channelId,
      contactId: params.contactId,
      conversationId,
      externalId: params.externalId,
      vars: params.vars,
      templateName: this.config.followUpTemplateName,
      textTemplate: this.config.followUpTemplate,
      source: 'sales_recovery_followup',
    });
    return { conversationId, sent };
  }

  /**
   * Enfileira a mensagem proativa pela fila `outbound-messages`. No WhatsApp
   * Oficial (Meta), fora da janela de 24h, é OBRIGATÓRIO usar template HSM
   * aprovado — texto livre é rejeitado. Então: oficial → TEMPLATE (se houver
   * nome configurado, senão pula com aviso); demais canais → TEXT. Retorna se
   * a mensagem foi de fato enfileirada.
   */
  private async enqueue(params: {
    organizationId: string;
    channelId: string;
    contactId: string;
    conversationId: string;
    externalId: string;
    vars: OpenerVars;
    templateName: string | null;
    textTemplate: string;
    source: string;
  }): Promise<boolean> {
    const {
      channelId,
      contactId,
      conversationId,
      externalId,
      vars,
      templateName,
      textTemplate,
      source,
    } = params;

    const channelType = await this.getChannelType(channelId);
    const requiresTemplate = channelType === ChannelType.WHATSAPP_OFFICIAL;

    let type: MessageContentType;
    let content: Prisma.InputJsonValue;
    if (requiresTemplate) {
      if (!templateName) {
        this.logger.warn(
          `Canal ${channelId} é WhatsApp Oficial e não há template configurado ` +
            `(RECOVERY_OPENER_TEMPLATE_NAME) — outreach pulado, card fica em Oportunidade.`,
        );
        return false;
      }
      type = MessageContentType.TEMPLATE;
      content = this.buildTemplate(templateName, vars);
    } else {
      type = MessageContentType.TEXT;
      content = { text: this.render(textTemplate, vars) };
    }

    const message = await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.OUTBOUND,
        type,
        content,
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
        message: { type, content },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(
      `Outreach (${type}) enfileirado: conv=${conversationId} canal=${channelType}`,
    );
    return true;
  }

  /**
   * Monta o objeto de template HSM da Cloud API pro `brvy_recuperacao_checkout`:
   * 2 variáveis no corpo — {{1}}=primeiro nome do lead, {{2}}=nome/alias do
   * produto. (Meta exige contagem exata; vazio vira "-".)
   */
  private buildTemplate(
    name: string,
    vars: OpenerVars,
  ): Prisma.InputJsonValue {
    const param = (v: string) => ({ type: 'text', text: v?.trim() || '-' });
    const firstName = (vars.nome ?? '').trim().split(/\s+/)[0] ?? '';
    return {
      name,
      language: { code: this.config.templateLang },
      components: [
        {
          type: 'body',
          parameters: [param(firstName), param(vars.produto)],
        },
      ],
    };
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
      // Recuperação sem IA (RECOVERY_AI_ENABLED=false): quem responde é
      // gente/Bravy OS — só garante a IA desligada nessa conversa.
      if (!this.config.aiEnabled) {
        await this.prisma.conversation.update({
          where: { id: open.id },
          data: { aiEnabled: false },
        });
        return open.id;
      }
      // Reaproveitando conversa existente: força o bot a assumir o funil de
      // recuperação — religa a IA, volta pra BOT e tira atribuição humana
      // (decisão do produto: a recuperação é conduzida pela IA). Sem isso,
      // uma conversa com kill-switch off de atendimento anterior nunca seria
      // respondida pela IA.
      await this.prisma.conversation.update({
        where: { id: open.id },
        data: {
          status: ConversationStatus.BOT,
          aiEnabled: true,
          assignedToId: null,
          ...(agentId ? { activeAgentId: agentId } : {}),
        },
      });
      return open.id;
    }

    const protocol = this.generateProtocol();
    const conversation = await this.prisma.conversation.create({
      data: {
        organizationId,
        channelId,
        contactId,
        // Sem IA a conversa nasce PENDING (pra gente/Bravy OS), não BOT.
        status: this.config.aiEnabled ? ConversationStatus.BOT : ConversationStatus.PENDING,
        aiEnabled: this.config.aiEnabled,
        protocol,
        isGroup: false,
        activeAgentId: this.config.aiEnabled ? (agentId ?? undefined) : undefined,
      },
      select: { id: true },
    });
    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: conversation.id,
        action: 'CREATED',
        toValue: this.config.aiEnabled ? ConversationStatus.BOT : ConversationStatus.PENDING,
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
