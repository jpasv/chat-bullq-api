import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { DashboardService } from '../../dashboard/dashboard.service';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg } from '../../../common/decorators';

function parseRange(from?: string, to?: string) {
  const now = new Date();
  return {
    from: from ? new Date(from) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    to: to ? new Date(to) : now,
  };
}

@ApiTags('Public API · Dashboard')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('public/dashboard')
export class PublicDashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Overview metrics (totals, deltas, current open/pending/etc.)' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getOverview(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getOverview(orgId, parseRange(from, to));
  }

  @Get('volume-by-day')
  @ApiOperation({ summary: 'Conversations volume per day' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getVolumeByDay(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getVolumeByDay(orgId, parseRange(from, to));
  }

  @Get('volume-by-channel')
  @ApiOperation({ summary: 'Conversations volume by channel' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getVolumeByChannel(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getVolumeByChannel(orgId, parseRange(from, to));
  }

  @Get('volume-by-status')
  @ApiOperation({ summary: 'Conversations grouped by status (current snapshot)' })
  getVolumeByStatus(@CurrentOrg('id') orgId: string) {
    return this.service.getVolumeByStatus(orgId);
  }

  @Get('kpi-sparklines')
  @ApiOperation({ summary: 'Daily series for hero KPIs (active, TMR, SLA, resolution)' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getKpiSparklines(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getKpiSparklines(orgId, parseRange(from, to));
  }

  @Get('agent-performance')
  @ApiOperation({ summary: 'Agent performance metrics' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getAgentPerformance(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getAgentPerformance(orgId, parseRange(from, to));
  }

  @Get('volume-flow')
  @ApiOperation({ summary: 'Conversations created vs closed per day' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getVolumeFlow(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getVolumeFlow(orgId, parseRange(from, to));
  }

  @Get('peak-hours')
  @ApiOperation({ summary: 'Conversation creation heatmap (day of week × hour)' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getPeakHours(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getPeakHours(orgId, parseRange(from, to));
  }

  @Get('messages-flow')
  @ApiOperation({ summary: 'Inbound vs outbound messages per day' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getMessagesFlow(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getMessagesFlow(orgId, parseRange(from, to));
  }

  @Get('bot-performance')
  @ApiOperation({ summary: 'Bot resolution vs human escalation breakdown' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getBotPerformance(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getBotPerformance(orgId, parseRange(from, to));
  }

  @Get('top-tags')
  @ApiOperation({ summary: 'Top tags / conversation reasons' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getTopTags(
    @CurrentOrg('id') orgId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    // Public API usa credencial de org (API key), sem usuário/AGENT — métricas
    // ficam org-wide (assignedToId undefined). Passa undefined p/ o escopo.
    return this.service.getTopTags(orgId, parseRange(from, to), undefined, limit ? parseInt(limit, 10) : 5);
  }
}
