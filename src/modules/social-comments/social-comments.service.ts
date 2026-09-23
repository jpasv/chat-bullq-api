import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Channel,
  MessageContentType,
  MessageDirection,
  MessageStatus,
  SocialComment,
  SocialCommentStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { InstagramHttpClient } from '../channel-hub/adapters/instagram/instagram.http-client';
import { ChannelAccess, ChannelAccessService } from '../iam/channel-access/channel-access.service';
import { ContactResolverService } from '../messaging/pipeline/contact-resolver.service';
import { ConversationResolverService } from '../messaging/pipeline/conversation-resolver.service';
import { MessagesRepository } from '../messaging/messages/messages.repository';
import { LlmService } from '../ai-agents/llm/llm.service';
import { SAKANA_CONVERSATION_MODEL } from '../ai-agents/llm/llm.constants';
import { SocialCommentsRepository, SocialCommentView } from './social-comments.repository';
import { ListCommentsQueryDto } from './dto/list-comments.query.dto';

/** Instagram só permite abrir DM a partir de um comentário até 7 dias após ele. */
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class SocialCommentsService {
  private readonly logger = new Logger(SocialCommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SocialCommentsRepository,
    private readonly instagram: InstagramHttpClient,
    private readonly channelAccess: ChannelAccessService,
    private readonly realtime: RealtimeGateway,
    private readonly contactResolver: ContactResolverService,
    private readonly conversationResolver: ConversationResolverService,
    private readonly messagesRepo: MessagesRepository,
    private readonly llm: LlmService,
  ) {}

  async list(orgId: string, access: ChannelAccess, query: ListCommentsQueryDto) {
    if (query.channelId) {
      this.channelAccess.assertChannelAccess(access, query.channelId);
    }
    return this.repo.listRoots({
      organizationId: orgId,
      channelIds: access === 'ALL' ? undefined : [...access],
      channelId: query.channelId,
      status: query.status,
      unreplied: query.unreplied === 'true',
      cursor: query.cursor,
      limit: query.limit ?? 30,
    });
  }

  async reply(id: string, orgId: string, userId: string, access: ChannelAccess, text: string) {
    const { comment, channel } = await this.loadActionable(id, orgId, access);
    if (comment.parentExternalId) {
      throw new BadRequestException('Responda o comentário raiz, não uma resposta');
    }
    const res = await this.graph(() => this.instagram.replyToComment(channel, comment.externalId, text));

    const cfg = (channel.config ?? {}) as Record<string, any>;
    await this.repo.createOrUpdateFromWebhook({
      organizationId: orgId,
      channelId: channel.id,
      externalId: String(res.id),
      parentExternalId: comment.externalId,
      mediaId: comment.mediaId,
      authorExternalId: String(cfg.igBusinessId ?? cfg.igUserId ?? ''),
      authorUsername: channel.name,
      text,
      isFromPage: true,
      commentedAt: new Date(),
    });
    await this.repo.markParentReplied(channel.id, comment.externalId, userId);
    return this.emitThread(channel.id, comment.externalId);
  }

  async setHidden(id: string, orgId: string, access: ChannelAccess, hidden: boolean) {
    const { comment, channel } = await this.loadActionable(id, orgId, access);
    await this.graph(() => this.instagram.setCommentHidden(channel, comment.externalId, hidden));
    await this.repo.update(id, {
      status: hidden ? SocialCommentStatus.HIDDEN : SocialCommentStatus.VISIBLE,
    });
    return this.emitThread(channel.id, comment.parentExternalId ?? comment.externalId);
  }

  async remove(id: string, orgId: string, access: ChannelAccess) {
    const { comment, channel } = await this.loadActionable(id, orgId, access);
    await this.graph(() => this.instagram.deleteComment(channel, comment.externalId));
    await this.repo.update(id, { status: SocialCommentStatus.DELETED });
    return this.emitThread(channel.id, comment.parentExternalId ?? comment.externalId);
  }

  async privateReply(id: string, orgId: string, userId: string, access: ChannelAccess, text: string) {
    const { comment, channel } = await this.loadActionable(id, orgId, access);
    if (comment.privateReplyConversationId) {
      throw new ConflictException({
        message: 'DM já aberta para este comentário',
        conversationId: comment.privateReplyConversationId,
      });
    }
    if (comment.isFromPage) {
      throw new BadRequestException('Não é possível abrir DM com a própria conta');
    }
    if (Date.now() - comment.commentedAt.getTime() > PRIVATE_REPLY_WINDOW_MS) {
      throw new BadRequestException('O Instagram só permite DM até 7 dias após o comentário');
    }

    const { contactId } = await this.contactResolver.resolveByExternalId(
      orgId,
      channel.id,
      comment.authorExternalId,
      comment.authorUsername ?? undefined,
    );
    const { conversationId } = await this.conversationResolver.resolveForOperator(
      orgId,
      channel.id,
      contactId,
      userId,
    );

    const sent = await this.graph(() =>
      this.instagram.sendPrivateReply(channel, comment.externalId, text),
    );

    // Guarda durável logo após o envio real — se algo abaixo falhar, o
    // retry cai no 409 em vez de mandar uma segunda DM de verdade.
    await this.repo.update(id, { privateReplyConversationId: conversationId });

    const message = await this.messagesRepo.create({
      conversationId,
      direction: MessageDirection.OUTBOUND,
      type: MessageContentType.TEXT,
      content: { text },
      status: MessageStatus.SENT,
      externalId: sent?.message_id ?? null,
      senderId: userId,
      sentAt: new Date(),
      metadata: { privateReplyOf: comment.externalId },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });
    this.realtime.emitToChannel(channel.id, 'message:new', { message, conversationId, contactId });
    this.realtime.emitToConversation(conversationId, 'message:new', { message });

    await this.emitThread(channel.id, comment.parentExternalId ?? comment.externalId);
    return { conversationId };
  }

  /**
   * Sugere um texto de resposta com IA — nunca envia nada, só devolve o
   * texto pra revisão do operador. Se o modelo achar que o comentário é
   * spam/ofensivo/sem mérito de resposta, devolve texto vazio com reason.
   */
  async suggest(id: string, orgId: string, access: ChannelAccess): Promise<{ text: string; reason?: 'spam' }> {
    const { comment, channel } = await this.loadActionable(id, orgId, access);
    const thread = await this.repo.findThread(channel.id, comment.parentExternalId ?? comment.externalId);
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true, aiBusinessNotes: true },
    });

    const system = [
      `Você responde comentários públicos no Instagram da conta "${channel.name}" (${org?.name ?? ''}).`,
      'Regras: responda em português do Brasil, tom cordial e direto, no máximo 2 frases.',
      'Não invente preços, prazos ou promoções que não estejam no contexto. Não inclua links.',
      'Se o comentário for spam, ofensivo ou não merecer resposta, responda exatamente: [SPAM]',
      org?.aiBusinessNotes?.trim() ? `\nSobre a empresa:\n${org.aiBusinessNotes.trim()}` : '',
    ].filter(Boolean).join('\n');

    const replies = (thread?.replies ?? [])
      .map((r) => `- ${r.isFromPage ? 'Página' : `@${r.authorUsername ?? r.authorExternalId}`}: ${r.text}`)
      .join('\n');
    const user = [
      `Legenda do post: ${thread?.mediaCaption ?? comment.mediaCaption ?? '(sem legenda)'}`,
      `Comentário de @${comment.authorUsername ?? comment.authorExternalId}: ${comment.text}`,
      replies ? `Respostas anteriores na thread:\n${replies}` : '',
      'Escreva só o texto da resposta.',
    ].filter(Boolean).join('\n\n');

    const resp = await this.llm.complete({
      modelId: SAKANA_CONVERSATION_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.5,
      maxTokens: 200,
    });

    const raw =
      typeof resp.message.content === 'string'
        ? resp.message.content
        : resp.message.content
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('');
    const text = raw.trim();
    if (!text || text.toUpperCase().includes('[SPAM]')) return { text: '', reason: 'spam' };
    return { text };
  }

  // ─── helpers ───────────────────────────────────────────────────────

  /** Carrega comentário + canal, valida org, acesso ao canal e status. */
  protected async loadActionable(
    id: string,
    orgId: string,
    access: ChannelAccess,
  ): Promise<{ comment: SocialComment; channel: Channel }> {
    const comment = await this.repo.findById(id);
    if (!comment || comment.organizationId !== orgId) {
      throw new NotFoundException('Comentário não encontrado');
    }
    this.channelAccess.assertChannelAccess(access, comment.channelId);
    if (comment.status === SocialCommentStatus.DELETED) {
      throw new BadRequestException('Comentário já foi deletado');
    }
    const channel = await this.prisma.channel.findUnique({ where: { id: comment.channelId } });
    if (!channel) throw new NotFoundException('Canal não encontrado');
    return { comment, channel };
  }

  /** Erro da Graph vira 502 com a mensagem da Meta. Nada foi persistido antes. */
  protected async graph<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      this.logger.warn(`Graph API error: ${err?.message ?? err}`);
      throw new BadGatewayException(err?.message ?? 'Erro na API do Instagram');
    }
  }

  protected async emitThread(channelId: string, rootExternalId: string): Promise<SocialCommentView> {
    const thread = await this.repo.findThread(channelId, rootExternalId);
    if (!thread) throw new NotFoundException('Comentário não encontrado');
    this.realtime.emitToChannel(channelId, 'comment:updated', thread);
    return thread;
  }
}
