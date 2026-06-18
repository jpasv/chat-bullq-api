import { Module } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';

/**
 * Projetos: cada grupo de WhatsApp tratado como um Projeto (keyed pelo JID).
 * Exporta o `ProjectsService` para o módulo de mensagens anexar/filtrar
 * projetos nas conversas de grupo.
 */
@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
