import {
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { ConversationsService } from './conversations.service';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import {
  CurrentUser,
  CurrentOrg,
  CurrentChannelAccess,
  Roles,
} from '../../../common/decorators';
import type { ChannelAccess } from '../../iam/channel-access/channel-access.service';

@ApiTags('Conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly service: ConversationsService) {}

  @Get()
  @ApiOperation({ summary: 'List conversations (inbox)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'channelId', required: false })
  @ApiQuery({ name: 'assignedToId', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({
    name: 'archived',
    required: false,
    description: 'exclude (default) | only | any',
  })
  @ApiQuery({
    name: 'unread',
    required: false,
    description: 'When "true", returns only conversations with unread inbound messages for the current user',
  })
  @ApiQuery({
    name: 'groups',
    required: false,
    description:
      'include (default — todas) | exclude (esconde grupos) | only (apenas grupos)',
  })
  @ApiQuery({
    name: 'tagIds',
    required: false,
    description:
      'CSV de IDs de tags. OR — devolve conversas que tenham QUALQUER uma das tags (na conversa OU no contato).',
  })
  findInbox(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('status') status?: string,
    @Query('channelId') channelId?: string,
    @Query('assignedToId') assignedToId?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('archived') archived?: string,
    @Query('unread') unread?: string,
    @Query('stuck') stuck?: string,
    @Query('groups') groups?: string,
    @Query('tagIds') tagIds?: string,
    @Query('segmentId') segmentId?: string,
    @Query('hoppeId') hoppeId?: string,
    @Query('responsibleUserId') responsibleUserId?: string,
    @Query('projectStatus') projectStatus?: string,
  ) {
    const archivedScope =
      archived === 'only' || archived === 'any' ? archived : 'exclude';
    // groups param maps to repository's existing `kind` filter:
    //   exclude → kind=INDIVIDUAL (esconde grupos)
    //   only    → kind=GROUP (apenas grupos)
    //   include / default → undefined (todas)
    const kind: 'INDIVIDUAL' | 'GROUP' | undefined =
      groups === 'exclude' ? 'INDIVIDUAL' : groups === 'only' ? 'GROUP' : undefined;
    const parsedTagIds = tagIds
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.service.findInbox(
      orgId,
      {
        status,
        channelId,
        assignedToId,
        search,
        archived: archivedScope,
        unreadOnly: unread === 'true' || unread === '1',
        stuckOnly: stuck === 'true' || stuck === '1',
        kind,
        tagIds: parsedTagIds?.length ? parsedTagIds : undefined,
        segmentId: segmentId || undefined,
        hoppeId: hoppeId || undefined,
        responsibleUserId: responsibleUserId || undefined,
        projectStatus: projectStatus || undefined,
      },
      parseInt(page || '1', 10),
      parseInt(limit || '20', 10),
      access,
      userId,
    );
  }

  @Post(':id/archive')
  @ApiOperation({ summary: 'Archive a conversation' })
  archive(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.setArchived(id, orgId, true, userId, access);
  }

  @Post(':id/unarchive')
  @ApiOperation({ summary: 'Unarchive a conversation' })
  unarchive(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.setArchived(id, orgId, false, userId, access);
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark conversation as read for current user' })
  markAsRead(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Body() body?: { lastReadMessageId?: string },
  ) {
    return this.service.markAsRead(
      id,
      orgId,
      userId,
      access,
      body?.lastReadMessageId,
    );
  }

  @Post(':id/unread')
  @ApiOperation({ summary: 'Mark conversation as unread for current user' })
  markAsUnread(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.markAsUnread(id, orgId, userId, access);
  }

  @Get('counts')
  @ApiOperation({ summary: 'Get conversation counts by status' })
  getCounts(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.getStatusCounts(orgId, access);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get conversation details' })
  findOne(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.findOne(id, orgId, access);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update conversation (assign, change status, department)' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdateConversationDto,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.update(id, orgId, dto, userId, access);
  }

  @Post(':id/assign-me')
  @ApiOperation({ summary: 'Assign conversation to current user' })
  assignToMe(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.assignToMe(id, orgId, userId, access);
  }

  @Patch(':id/ai')
  @ApiOperation({
    summary:
      'Override AI behavior on this conversation. enabled=true forces AI on (overrides kill switch and business hours), false forces off, null clears the override (follows global rules).',
  })
  toggleAi(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Body() body: { enabled: boolean | null },
  ) {
    const value =
      body?.enabled === null || body?.enabled === undefined
        ? null
        : !!body.enabled;
    return this.service.toggleAi(id, orgId, value, userId, access);
  }

  @Post(':id/ai/engage')
  @ApiOperation({
    summary:
      'Manually engage the AI on this conversation right now. The agent reads the full message history, decides what to do (reply, delegate, transfer) and acts. Useful when the inbound stream is silent but a human wants the AI to take over (e.g. after pausing then resuming).',
  })
  engageAi(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.engageAi(id, orgId, userId, access);
  }

  @Post(':id/ai/set-agent')
  @ApiOperation({
    summary:
      'Pin a specific AI agent to this conversation and immediately engage it. Sets activeAgentId + aiEnabled=true + fires the runner. Use case: human picks Lívia/André via UI when delegating manually.',
  })
  setActiveAgent(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Body() body: { agentId: string },
  ) {
    return this.service.setActiveAgent(
      id,
      orgId,
      body.agentId,
      userId,
      access,
    );
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Close a conversation' })
  close(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.close(id, orgId, userId, access);
  }

  @Post(':id/reopen')
  @ApiOperation({ summary: 'Reopen a closed conversation' })
  reopen(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.reopen(id, orgId, userId, access);
  }

  @Post(':id/sync')
  @ApiOperation({
    summary:
      'Force-sync the latest messages for a conversation from the channel provider',
  })
  syncMessages(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.syncMessages(id, orgId, access);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({
    summary:
      'HARD-delete a conversation: cascades to messages, attachments, tags, AI runs, reads. Irreversible — requires ?confirm=<exact contact name or phone>.',
  })
  @ApiQuery({
    name: 'confirm',
    required: true,
    description:
      'Type the contact name or phone exactly to authorize the destructive action.',
  })
  remove(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('confirm') confirm: string,
  ) {
    return this.service.hardDelete(id, orgId, access, confirm);
  }
}
