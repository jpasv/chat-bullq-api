import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { UpdateProjectDto } from './dto/project.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('projects')
export class ProjectsController {
  constructor(private readonly service: ProjectsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Lista os projetos (um por grupo da org) com os dados do projeto e a conversa representante.',
  })
  list(
    @CurrentOrg('id') orgId: string,
    @Query('hoppeId') hoppeId?: string,
    @Query('responsibleUserId') responsibleUserId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.service.list(orgId, { hoppeId, responsibleUserId, status, search });
  }

  @Get('filters')
  @ApiOperation({ summary: 'Valores distintos (hoppeId/status) p/ os filtros' })
  filters(@CurrentOrg('id') orgId: string) {
    return this.service.filters(orgId);
  }

  @Get('by-conversation/:conversationId')
  @ApiOperation({ summary: 'Dados do projeto do grupo desta conversa' })
  getByConversation(
    @Param('conversationId') conversationId: string,
    @CurrentOrg('id') orgId: string,
  ) {
    return this.service.getForConversation(orgId, conversationId);
  }

  @Put('by-conversation/:conversationId')
  @ApiOperation({
    summary:
      'Cria/atualiza o projeto do grupo desta conversa (upsert por JID; metadata é mesclado).',
  })
  updateByConversation(
    @Param('conversationId') conversationId: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.service.updateForConversation(orgId, conversationId, dto);
  }
}
