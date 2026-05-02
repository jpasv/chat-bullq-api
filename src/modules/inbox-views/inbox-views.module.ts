import { Module, forwardRef } from '@nestjs/common';
import { InboxViewsController } from './inbox-views.controller';
import { InboxViewsService } from './inbox-views.service';
import { MessagingModule } from '../messaging/messaging.module';
import { ChannelAccessModule } from '../iam/channel-access/channel-access.module';

@Module({
  imports: [forwardRef(() => MessagingModule), ChannelAccessModule],
  controllers: [InboxViewsController],
  providers: [InboxViewsService],
})
export class InboxViewsModule {}
