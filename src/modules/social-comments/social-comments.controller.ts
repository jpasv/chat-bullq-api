import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentChannelAccess, CurrentOrg, CurrentUser, Roles } from '../../common/decorators';
import { ChannelAccess } from '../iam/channel-access/channel-access.service';
import { SocialCommentsService } from './social-comments.service';
import { ListCommentsQueryDto } from './dto/list-comments.query.dto';
import { ReplyCommentDto } from './dto/reply-comment.dto';
import { HideCommentDto } from './dto/hide-comment.dto';

@ApiTags('Social Comments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('social-comments')
export class SocialCommentsController {
  constructor(private readonly service: SocialCommentsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista comentários raiz com replies aninhadas' })
  list(
    @Query() query: ListCommentsQueryDto,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.list(orgId, access, query);
  }

  @Post(':id/reply')
  @ApiOperation({ summary: 'Responde publicamente o comentário' })
  reply(
    @Param('id') id: string,
    @Body() dto: ReplyCommentDto,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.reply(id, orgId, userId, access, dto.text);
  }

  @Patch(':id/hide')
  @ApiOperation({ summary: 'Oculta ou desoculta o comentário no Instagram' })
  hide(
    @Param('id') id: string,
    @Body() dto: HideCommentDto,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.setHidden(id, orgId, access, dto.hidden);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Deleta o comentário no Instagram (soft no banco)' })
  remove(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.remove(id, orgId, access);
  }
}
