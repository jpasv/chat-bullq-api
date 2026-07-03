import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InboxViewsService } from './inbox-views.service';
import {
  CreateInboxViewDto,
  ReorderInboxViewsDto,
  UpdateInboxViewDto,
} from './dto/inbox-view.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import {
  CurrentChannelAccess,
  CurrentOrg,
  CurrentUser,
  CurrentUserRole,
} from '../../common/decorators';
import type { ChannelAccess } from '../iam/channel-access/channel-access.service';
import { OrgRole } from '@prisma/client';

@ApiTags('Inbox Views')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('inbox-views')
export class InboxViewsController {
  constructor(private readonly service: InboxViewsService) {}

  @Get()
  @ApiOperation({ summary: 'List my inbox views (personal scope)' })
  list(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.list(orgId, userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create an inbox view' })
  create(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateInboxViewDto,
  ) {
    return this.service.create(orgId, userId, dto);
  }

  @Patch('reorder')
  @ApiOperation({ summary: 'Reorder my inbox views (drag-drop)' })
  reorder(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ReorderInboxViewsDto,
  ) {
    return this.service.reorder(orgId, userId, dto.ids);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an inbox view' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateInboxViewDto,
  ) {
    return this.service.update(id, orgId, userId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an inbox view' })
  remove(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.remove(id, orgId, userId);
  }

  @Get(':id/conversations')
  @ApiOperation({
    summary:
      'List conversations matching this view filters. Query params layer ON TOP — view = baseline, params = override (mesma semântica do inbox geral).',
  })
  conversations(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('unread') unread?: string,
    @Query('archived') archived?: string,
    @Query('groups') groups?: string,
    @Query('channelId') channelId?: string,
    @Query('tagIds') tagIds?: string,
    @Query('assignedToId') assignedToId?: string,
    @Query('stuck') stuck?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.service.findConversations(
      id,
      orgId,
      userId,
      access,
      parseInt(page || '1', 10),
      parseInt(limit || '20', 10),
      search,
      {
        unread,
        archived,
        groups,
        channelId,
        tagIds,
        assignedToId,
        stuck,
        dateFrom,
        dateTo,
      },
      role,
    );
  }
}
