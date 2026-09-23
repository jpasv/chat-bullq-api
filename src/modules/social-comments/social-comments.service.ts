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
import { SocialCommentsRepository, SocialCommentView } from './social-comments.repository';
import { ListCommentsQueryDto } from './dto/list-comments.query.dto';

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

    const sent = await this.graph(() =>
      this.instagram.sendPrivateReply(channel, comment.externalId, text),
    );

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

    await this.repo.update(id, { privateReplyConversationId: conversationId });
    await this.emitThread(channel.id, comment.parentExternalId ?? comment.externalId);
    return { conversationId };
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
