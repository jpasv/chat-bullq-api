import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import type { Response } from 'express';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, Public, Roles } from '../../common/decorators';
import { UpsertIgFlowDto } from './dto/upsert-ig-flow.dto';
import { IgFlowsService } from './ig-flows.service';
import { IgFlowRunnerService } from './ig-flow-runner.service';

@ApiTags('Instagram Flows')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Roles(OrgRole.OWNER, OrgRole.ADMIN)
@Controller('ig-flows')
export class IgFlowsController {
  constructor(private readonly service: IgFlowsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista fluxos do Instagram' })
  list(@CurrentOrg('id') orgId: string) {
    return this.service.list(orgId);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.get(id, orgId);
  }

  @Post()
  create(@Body() dto: UpsertIgFlowDto, @CurrentOrg('id') orgId: string) {
    return this.service.create(orgId, dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpsertIgFlowDto, @CurrentOrg('id') orgId: string) {
    return this.service.update(id, orgId, dto);
  }

  @Patch(':id/active')
  setActive(@Param('id') id: string, @Body('isActive') isActive: boolean, @CurrentOrg('id') orgId: string) {
    return this.service.setActive(id, orgId, !!isActive);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(id, orgId);
  }

  @Get(':id/runs')
  @ApiOperation({ summary: 'Execuções recentes do fluxo (debug)' })
  runs(@Param('id') id: string, @CurrentOrg('id') orgId: string, @Query('limit') limit?: string) {
    return this.service.runs(id, orgId, limit ? Number(limit) : undefined);
  }
}

/** Redirect público dos botões de link: registra o clique e segue o fluxo. */
@ApiTags('Instagram Flows')
@Controller('ig-flows/r')
export class IgFlowsRedirectController {
  constructor(private readonly runner: IgFlowRunnerService) {}

  @Get(':runId/:buttonId')
  @Public()
  async redirect(@Param('runId') runId: string, @Param('buttonId') buttonId: string, @Res() res: Response) {
    const url = await this.runner.handleLinkClick(runId, buttonId);
    if (!url) return res.status(404).send('Link não encontrado');
    return res.redirect(302, url);
  }
}
