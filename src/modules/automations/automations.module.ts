import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../database/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { OutboxService } from './outbox/outbox.service';
import { OutboxPollerService } from './outbox/outbox-poller.service';
import { AutomationEventProcessor } from './workers/automation-event.processor';
import { KillSwitchService } from './kill-switch.service';
import { AutomationRedisService } from './redis/automation-redis.service';
import { ConditionsEvaluator } from './engine/conditions-evaluator';
import { AutomationExecutorService } from './engine/automation-executor.service';
import { ActionRegistryService } from './actions/action-registry.service';
import { AddTagHandler } from './actions/handlers/add-tag.handler';
import { RemoveTagHandler } from './actions/handlers/remove-tag.handler';
import { AddToPipelineHandler } from './actions/handlers/add-to-pipeline.handler';
import { MovePipelineStageHandler } from './actions/handlers/move-pipeline-stage.handler';
import { AssignUserHandler } from './actions/handlers/assign-user.handler';
import { SendMessageHandler } from './actions/handlers/send-message.handler';
import { AutomationsService } from './automations.service';
import { AutomationsController } from './automations.controller';
import { AutomationsRunsController } from './automations-runs.controller';
import { AutomationsValidator } from './automations.validator';
import { AUTOMATION_QUEUE } from './automations.constants';

@Global()
@Module({
  imports: [
    PrismaModule,
    RealtimeModule,
    WebhooksModule,
    BullModule.registerQueue(
      { name: AUTOMATION_QUEUE },
      // send_message uses the existing outbound queue. Registering it
      // here pulls it into this module's scope so the handler can inject.
      { name: 'outbound-messages' },
    ),
  ],
  controllers: [AutomationsController, AutomationsRunsController],
  providers: [
    KillSwitchService,
    AutomationRedisService,
    OutboxService,
    OutboxPollerService,
    ConditionsEvaluator,
    AutomationExecutorService,
    AutomationEventProcessor,
    AutomationsService,
    AutomationsValidator,
    // Handlers + registry
    AddTagHandler,
    RemoveTagHandler,
    AddToPipelineHandler,
    MovePipelineStageHandler,
    AssignUserHandler,
    SendMessageHandler,
    ActionRegistryService,
  ],
  exports: [OutboxService, KillSwitchService],
})
export class AutomationsModule {}
