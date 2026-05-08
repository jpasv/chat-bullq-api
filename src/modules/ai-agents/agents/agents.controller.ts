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
import { OrgRole } from '@prisma/client';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AssignAgentChannelDto } from './dto/assign-channel.dto';
import { CurrentOrg, Roles } from '../../../common/decorators';
import {
  JwtAuthGuard,
  OrgGuard,
  RolesGuard,
} from '../../../common/guards';

@ApiTags('AI Agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('ai-agents')
export class AgentsController {
  constructor(private readonly service: AgentsService) {}

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Create a new AI agent' })
  create(@CurrentOrg('id') orgId: string, @Body() dto: CreateAgentDto) {
    return this.service.create(orgId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List AI agents for the organization' })
  list(@CurrentOrg('id') orgId: string) {
    return this.service.list(orgId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single AI agent' })
  findOne(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.findOne(orgId, id);
  }

  @Patch(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Update an AI agent' })
  update(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAgentDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Soft-delete an AI agent' })
  remove(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.softDelete(orgId, id);
  }

  @Post(':id/channels')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Assign agent to a channel (or update mode)' })
  assignChannel(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Body() dto: AssignAgentChannelDto,
  ) {
    return this.service.assignChannel(orgId, id, dto);
  }

  @Delete(':id/channels/:channelId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Detach agent from a channel' })
  unassignChannel(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Param('channelId') channelId: string,
  ) {
    return this.service.unassignChannel(orgId, id, channelId);
  }

  @Get(':id/runs')
  @ApiOperation({ summary: 'List recent runs of this agent (with tool calls)' })
  runs(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listRuns(
      orgId,
      id,
      limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50,
    );
  }

  @Get('runs/feed')
  @ApiOperation({
    summary:
      'Org-wide run feed for the Jarvis "Execuções" tab. Returns runs with full tool-call history (input/output/error) so the UI can surface silent failures (HTTP 4xx/5xx, ok:false). Filterable by period, agent, status, finalAction and "only with errors".',
  })
  feed(
    @CurrentOrg('id') orgId: string,
    @Query('agentId') agentId?: string,
    @Query('period') period?: string,
    @Query('status') status?: string,
    @Query('finalAction') finalAction?: string,
    @Query('hasErrors') hasErrors?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listOrgRuns(orgId, {
      agentId,
      period: this.parsePeriodAll(period),
      status: this.parseRunStatus(status),
      finalAction,
      hasErrors: hasErrors === '1' || hasErrors === 'true',
      limit: limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50,
      cursor: cursor || undefined,
    });
  }

  @Get('stats/overview')
  @ApiOperation({
    summary: 'Aggregated org stats over a window: cost, tokens, runs, tools.',
  })
  orgStats(
    @CurrentOrg('id') orgId: string,
    @Query('period') period?: string,
  ) {
    const p = this.parsePeriod(period);
    return this.service.getOrgStats(orgId, p);
  }

  @Get(':id/stats')
  @ApiOperation({ summary: 'Aggregated stats for a single agent.' })
  agentStats(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Query('period') period?: string,
  ) {
    const p = this.parsePeriod(period);
    return this.service.getAgentStats(orgId, id, p);
  }

  private parsePeriod(p?: string): '24h' | '7d' | '30d' {
    if (p === '24h' || p === '7d' || p === '30d') return p;
    return '7d';
  }

  private parsePeriodAll(p?: string): '24h' | '7d' | '30d' | 'all' {
    if (p === '24h' || p === '7d' || p === '30d' || p === 'all') return p;
    return '7d';
  }

  private parseRunStatus(s?: string) {
    if (s === 'RUNNING' || s === 'COMPLETED' || s === 'FAILED' || s === 'SKIPPED') {
      return s;
    }
    return undefined;
  }
}
