import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser, CurrentUserRole } from '../../common/decorators';
import { resolveAssignmentScope } from '../messaging/conversations/conversation-scope';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  private parseRange(from?: string, to?: string) {
    const now = new Date();
    return {
      from: from ? new Date(from) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      to: to ? new Date(to) : now,
    };
  }

  /**
   * Barreira de atribuição (RN-05): AGENT só vê métricas das próprias
   * conversas; OWNER/ADMIN veem a org inteira (undefined). Todo endpoint do
   * dashboard é AGENT-alcançável (o controller não tem @Roles), então cada
   * agregado escopa por este valor.
   */
  private assignmentScope(userId: string, role: OrgRole | undefined) {
    return resolveAssignmentScope(role, userId);
  }

  @Get('overview')
  @ApiOperation({ summary: 'Get dashboard overview metrics' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getOverview(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getOverview(
      orgId,
      this.parseRange(from, to),
      this.assignmentScope(userId, role),
    );
  }

  @Get('volume-by-day')
  @ApiOperation({ summary: 'Conversations volume by day' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getVolumeByDay(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getVolumeByDay(
      orgId,
      this.parseRange(from, to),
      this.assignmentScope(userId, role),
    );
  }

  @Get('volume-by-channel')
  @ApiOperation({ summary: 'Conversations volume by channel' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getVolumeByChannel(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getVolumeByChannel(
      orgId,
      this.parseRange(from, to),
      this.assignmentScope(userId, role),
    );
  }

  @Get('volume-by-status')
  @ApiOperation({ summary: 'Conversations by status (current)' })
  getVolumeByStatus(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
  ) {
    return this.service.getVolumeByStatus(orgId, this.assignmentScope(userId, role));
  }

  @Get('kpi-sparklines')
  @ApiOperation({ summary: 'Daily series for hero KPIs (active, TMR, SLA, resolution)' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getKpiSparklines(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getKpiSparklines(
      orgId,
      this.parseRange(from, to),
      this.assignmentScope(userId, role),
    );
  }

  @Get('agent-performance')
  @ApiOperation({ summary: 'Agent performance metrics' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getAgentPerformance(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getAgentPerformance(
      orgId,
      this.parseRange(from, to),
      this.assignmentScope(userId, role),
    );
  }

  @Get('volume-flow')
  @ApiOperation({ summary: 'Conversations created vs closed per day' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getVolumeFlow(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getVolumeFlow(
      orgId,
      this.parseRange(from, to),
      this.assignmentScope(userId, role),
    );
  }

  @Get('peak-hours')
  @ApiOperation({ summary: 'Conversation creation heatmap (day of week × hour)' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getPeakHours(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getPeakHours(
      orgId,
      this.parseRange(from, to),
      this.assignmentScope(userId, role),
    );
  }

  @Get('messages-flow')
  @ApiOperation({ summary: 'Inbound vs outbound messages per day' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getMessagesFlow(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getMessagesFlow(
      orgId,
      this.parseRange(from, to),
      this.assignmentScope(userId, role),
    );
  }

  @Get('bot-performance')
  @ApiOperation({ summary: 'Bot resolution vs human escalation breakdown' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getBotPerformance(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getBotPerformance(
      orgId,
      this.parseRange(from, to),
      this.assignmentScope(userId, role),
    );
  }

  @Get('csat')
  @ApiOperation({ summary: 'CSAT breakdown (avg, distribution, recent comments)' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getCsat(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getCsatBreakdown(
      orgId,
      this.parseRange(from, to),
      this.assignmentScope(userId, role),
    );
  }

  @Get('reopens')
  @ApiOperation({ summary: 'Conversation reopen tracking + worst offenders' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getReopens(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getReopens(
      orgId,
      this.parseRange(from, to),
      this.assignmentScope(userId, role),
    );
  }

  @Get('top-tags')
  @ApiOperation({ summary: 'Top tags / conversation reasons' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getTopTags(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentUserRole() role: OrgRole,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getTopTags(
      orgId,
      this.parseRange(from, to),
      this.assignmentScope(userId, role),
      limit ? parseInt(limit, 10) : 5,
    );
  }
}
