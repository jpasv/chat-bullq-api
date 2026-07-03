import { Module } from '@nestjs/common';
import { PublicMeController } from './controllers/public-me.controller';
import { PublicDashboardController } from './controllers/public-dashboard.controller';
import { PublicContactsController } from './controllers/public-contacts.controller';
import { PublicChannelsController } from './controllers/public-channels.controller';
import { PublicConversationsController } from './controllers/public-conversations.controller';
import { PublicMessagesController } from './controllers/public-messages.controller';
import { ApiKeyThrottleGuard } from './guards/api-key-throttle.guard';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AuthModule } from '../auth/auth.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ChannelHubModule } from '../channel-hub/channel-hub.module';

@Module({
  imports: [AuthModule, DashboardModule, MessagingModule, ChannelHubModule],
  controllers: [
    PublicMeController,
    PublicDashboardController,
    PublicContactsController,
    PublicChannelsController,
    PublicConversationsController,
    PublicMessagesController,
  ],
  providers: [ApiKeyThrottleGuard],
})
export class PublicApiModule {}
