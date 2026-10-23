import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { InstagramModule } from '../channel-hub/adapters/instagram/instagram.module';
import { MessagingModule } from '../messaging/messaging.module';
import { IgFlowsController, IgFlowsRedirectController } from './ig-flows.controller';
import { IgFlowsService } from './ig-flows.service';
import { IgFlowRunnerService } from './ig-flow-runner.service';
import { IgFlowsProcessor } from './ig-flows.processor';
import { IG_FLOWS_QUEUE } from './ig-flows.types';

@Module({
  imports: [
    InstagramModule,
    forwardRef(() => MessagingModule),
    BullModule.registerQueue({ name: IG_FLOWS_QUEUE }),
  ],
  controllers: [IgFlowsController, IgFlowsRedirectController],
  providers: [IgFlowsService, IgFlowRunnerService, IgFlowsProcessor],
})
export class IgFlowsModule {}
