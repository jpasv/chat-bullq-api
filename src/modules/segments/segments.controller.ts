import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { SegmentsService } from './segments.service';
import {
  CreateSegmentDto,
  SetPrimaryChannelDto,
  SetSegmentChannelsDto,
  UpdateSegmentDto,
} from './dto/segment.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, Roles } from '../../common/decorators';

@ApiTags('Segments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('segments')
export class SegmentsController {
  constructor(private readonly service: SegmentsService) {}

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({
    summary:
      'Cria um segmento: vários canais (números) que compartilham grupos e histórico, ancorados num canal principal.',
  })
  create(
    @CurrentOrg('id') orgId: string,
    @Body() dto: CreateSegmentDto,
  ) {
    return this.service.create(orgId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista os segmentos da organização' })
  findAll(@CurrentOrg('id') orgId: string) {
    return this.service.findAll(orgId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um segmento' })
  findOne(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.findOne(id, orgId);
  }

  @Patch(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Atualiza nome ou ativa/desativa o segmento' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdateSegmentDto,
  ) {
    return this.service.update(id, orgId, dto);
  }

  @Put(':id/channels')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Define o conjunto de canais membros do segmento' })
  setChannels(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: SetSegmentChannelsDto,
  ) {
    return this.service.setChannels(id, orgId, dto);
  }

  @Put(':id/primary-channel')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({
    summary: 'Define o canal principal (por onde as respostas saem)',
  })
  setPrimary(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: SetPrimaryChannelDto,
  ) {
    return this.service.setPrimary(id, orgId, dto);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Remove (soft delete) o segmento' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(id, orgId);
  }
}
