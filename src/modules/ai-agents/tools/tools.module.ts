import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../../database/prisma.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { ReplyToConversationTool } from './builtin/reply-to-conversation.tool';
import { TransferToHumanTool } from './builtin/transfer-to-human.tool';
import { TagConversationTool } from './builtin/tag-conversation.tool';
import { ListAvailableAgentsTool } from './builtin/list-available-agents.tool';
import { DelegateToAgentTool } from './builtin/delegate-to-agent.tool';
import { HandBackToOrchestratorTool } from './builtin/hand-back-to-orchestrator.tool';
import { GetProductPitchTool } from './builtin/get-product-pitch.tool';
import { CheckBonusEligibilityTool } from './builtin/check-bonus-eligibility.tool';
import { CheckMembersAccessTool } from './builtin/check-members-access.tool';
import { ConsultarClickUpClienteTool } from './builtin/consultar-clickup-cliente.tool';
import { ConsultarN8nClienteTool } from './builtin/consultar-n8n-cliente.tool';
import { ListarReunioesClienteTool } from './builtin/listar-reunioes-cliente.tool';
import { LerTranscricaoReuniaoTool } from './builtin/ler-transcricao-reuniao.tool';
import { AgendarReuniaoTool } from './builtin/agendar-reuniao.tool';
import { MoveRecoveryCardTool } from './builtin/move-recovery-card.tool';
import { HoppeClientService } from './client-ops/hoppe-client.service';
import { GoogleAuthService } from './client-ops/google-auth.service';
import { GoogleCalendarService } from './client-ops/google-calendar.service';
import { GoogleDriveService } from './client-ops/google-drive.service';
import { ClickUpClientService } from './client-ops/clickup-client.service';
import { N8nClientService } from './client-ops/n8n-client.service';
import { GroupNotifyService } from './client-ops/group-notify.service';
import { ToolRegistry } from './tool-registry.service';
import { HttpToolExecutorService } from './http-tool-executor.service';
import { SqlToolExecutorService } from './sql-tool-executor.service';
import { ConfigModule } from '@nestjs/config';
import { ConfirmationsModule } from '../confirmations/confirmations.module';
import { SalesRecoveryModule } from '../../sales-recovery/sales-recovery.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RealtimeModule,
    ConfirmationsModule,
    SalesRecoveryModule,
    BullModule.registerQueue({ name: 'outbound-messages' }),
  ],
  providers: [
    ReplyToConversationTool,
    TransferToHumanTool,
    TagConversationTool,
    ListAvailableAgentsTool,
    DelegateToAgentTool,
    HandBackToOrchestratorTool,
    GetProductPitchTool,
    CheckBonusEligibilityTool,
    CheckMembersAccessTool,
    HoppeClientService,
    GoogleAuthService,
    GoogleCalendarService,
    GoogleDriveService,
    ClickUpClientService,
    N8nClientService,
    GroupNotifyService,
    ConsultarClickUpClienteTool,
    ConsultarN8nClienteTool,
    ListarReunioesClienteTool,
    LerTranscricaoReuniaoTool,
    AgendarReuniaoTool,
    MoveRecoveryCardTool,
    ToolRegistry,
    HttpToolExecutorService,
    SqlToolExecutorService,
  ],
  exports: [ToolRegistry, HttpToolExecutorService, SqlToolExecutorService],
})
export class ToolsModule {}
