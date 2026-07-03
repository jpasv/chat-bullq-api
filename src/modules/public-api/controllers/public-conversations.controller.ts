import { Controller, Get, Post, Param, Query, Body, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg, CurrentUser } from '../../../common/decorators';
import { ApiKeyThrottleGuard } from '../guards/api-key-throttle.guard';
import { ConversationsService } from '../../messaging/conversations/conversations.service';
import { MessagesService } from '../../messaging/messages/messages.service';
import { mapConversation } from '../mappers/conversation.mapper';
import { mapMessage } from '../mappers/message.mapper';
import { toPublicPage } from '../dto/public-page';
import { ListConversationsPublicDto } from '../dto/list-conversations.public.dto';
import { AssignConversationPublicDto } from '../dto/assign-conversation.public.dto';

@ApiTags('Public API · Conversations')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard, ApiKeyThrottleGuard)
@Controller('public/conversations')
export class PublicConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Lista conversas (paginado, filtros por status/canal/tag/busca)' })
  async list(@CurrentOrg('id') orgId: string, @Query() q: ListConversationsPublicDto) {
    const filters = {
      status: q.status,
      channelId: q.channelId,
      tagIds: q.tagIds?.split(',').map((t) => t.trim()).filter(Boolean),
      search: q.search,
    };
    const { conversations, pagination } = await this.conversations.findInbox(orgId, filters, q.page, q.limit, 'ALL');
    return toPublicPage(conversations.map(mapConversation), pagination.total, q.page, q.limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma conversa' })
  async get(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return mapConversation(await this.conversations.findOne(id, orgId, 'ALL'));
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Lista mensagens da conversa (paginado)' })
  async messagesOf(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const p = Number(page) || 1;
    const l = Math.min(Number(limit) || 20, 100);
    const { messages, pagination } = await this.messages.findByConversation(id, orgId, p, l, 'ALL');
    return toPublicPage(messages.map(mapMessage), pagination.total, p, l);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Fecha a conversa' })
  async close(@CurrentOrg('id') orgId: string, @CurrentUser('id') userId: string, @Param('id') id: string) {
    return mapConversation(await this.conversations.close(id, orgId, userId, 'ALL'));
  }

  @Post(':id/reopen')
  @ApiOperation({ summary: 'Reabre a conversa' })
  async reopen(@CurrentOrg('id') orgId: string, @CurrentUser('id') userId: string, @Param('id') id: string) {
    return mapConversation(await this.conversations.reopen(id, orgId, userId, 'ALL'));
  }

  @Post(':id/assign')
  @ApiOperation({ summary: 'Transfere a conversa (usuário e/ou setor)' })
  async assign(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: AssignConversationPublicDto,
  ) {
    return mapConversation(await this.conversations.update(id, orgId, dto as any, userId, 'ALL'));
  }
}
