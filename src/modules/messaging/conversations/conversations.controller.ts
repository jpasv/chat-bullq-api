import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ConversationsService } from './conversations.service';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import {
  CurrentUser,
  CurrentOrg,
  CurrentChannelAccess,
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
  findInbox(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('status') status?: string,
    @Query('channelId') channelId?: string,
    @Query('assignedToId') assignedToId?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findInbox(
      orgId,
      { status, channelId, assignedToId, search },
      parseInt(page || '1', 10),
      parseInt(limit || '20', 10),
      access,
    );
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
}
