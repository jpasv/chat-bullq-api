import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RecoveryConfigService } from './recovery-config.service';
import { RecoveryCardsRepository } from './recovery-cards.repository';
import { RecoveryOutreachService } from './recovery-outreach.service';
import { SalesRecoveryService } from './sales-recovery.service';
import { RecoveryWatchdogCron } from './recovery-watchdog.cron';
import { KirvanoWebhookController } from './webhooks/kirvano-webhook.controller';
import { KirvanoEventsService } from './webhooks/kirvano-events.service';
import { KirvanoEventsProcessor } from './webhooks/kirvano-events.processor';
import {
  KIRVANO_EVENTS_QUEUE,
  RECOVERY_WATCHDOG_QUEUE,
} from './sales-recovery.constants';

/**
 * Recuperação de Vendas: webhooks da Kirvano + cold outreach por IA movendo
 * um pipeline kanban automaticamente. Reusa PipelinesService pra toda mutação
 * de card (ordem/status/eventos socket). Exporta SalesRecoveryService pro
 * pipeline de inbound chamar `onInboundReply` (Tentativa → Em Contato).
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: KIRVANO_EVENTS_QUEUE },
      { name: RECOVERY_WATCHDOG_QUEUE },
      { name: 'outbound-messages' },
    ),
    PipelinesModule,
    RealtimeModule,
  ],
  controllers: [KirvanoWebhookController],
  providers: [
    RecoveryConfigService,
    RecoveryCardsRepository,
    RecoveryOutreachService,
    SalesRecoveryService,
    KirvanoEventsService,
    KirvanoEventsProcessor,
    RecoveryWatchdogCron,
  ],
  exports: [SalesRecoveryService],
})
export class SalesRecoveryModule {}
