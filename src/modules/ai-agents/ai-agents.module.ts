import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { LlmModule } from './llm/llm.module';
import { ToolsModule } from './tools/tools.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ChannelHubModule } from '../channel-hub/channel-hub.module';
import { PromptBuilderService } from './runner/prompt-builder.service';
import { AiAgentRunnerService } from './runner/agent-runner.service';
import { ModelRouterService } from './runner/model-router.service';
import { CatalogSyncService } from './runner/catalog-sync.service';
import { MediaUrlResolverService } from './runner/media-url-resolver.service';
import { AgentRouterService } from './router/agent-router.service';
import { AgentsService } from './agents/agents.service';
import { AgentsController } from './agents/agents.controller';
import { ToolsCatalogService } from './catalog/tools.service';
import { SkillsCatalogService } from './catalog/skills.service';
import { AiCatalogController } from './catalog/catalog.controller';

// ─── Fase 2 — AI Intelligence Layer ──────────────
import { PromptsModule } from './prompts/prompts.module';
import { ClassifierModule } from './classifier/classifier.module';
import { ShortTermMemoryModule } from './memory/short-term/short-term.module';
import { LongTermMemoryModule } from './memory/long-term/long-term.module';
import { ConfirmationsModule } from './confirmations/confirmations.module';
import { ConfirmationExecutorModule } from './confirmations/confirmation-executor.module';
import { RagModule } from './rag/rag.module';
import { EvalsModule } from './evals/evals.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    LlmModule,
    ToolsModule,
    NotificationsModule,
    RealtimeModule,
    forwardRef(() => ChannelHubModule),
    PromptsModule,
    ClassifierModule,
    ShortTermMemoryModule,
    LongTermMemoryModule,
    ConfirmationsModule,
    ConfirmationExecutorModule,
    RagModule,
    EvalsModule,
  ],
  controllers: [AgentsController, AiCatalogController],
  providers: [
    PromptBuilderService,
    AiAgentRunnerService,
    ModelRouterService,
    AgentRouterService,
    AgentsService,
    ToolsCatalogService,
    SkillsCatalogService,
    CatalogSyncService,
    MediaUrlResolverService,
  ],
  exports: [AiAgentRunnerService, AgentRouterService],
})
export class AiAgentsModule {}
