import { Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { WebhookGatewayController } from './webhook-gateway.controller';
import { ChannelsController } from './channels/channels.controller';
import { ChannelsService } from './channels/channels.service';
import { ChannelsRepository } from './channels/channels.repository';
import { ZappfyModule } from './adapters/zappfy/zappfy.module';
import { ZappfyInboundAdapter } from './adapters/zappfy/zappfy.inbound-adapter';
import { ZappfyOutboundAdapter } from './adapters/zappfy/zappfy.outbound-adapter';
import { ZappfySyncAdapter } from './adapters/zappfy/zappfy.sync-adapter';
import { WhatsAppOfficialModule } from './adapters/whatsapp-official/whatsapp-official.module';
import { WhatsAppOfficialInboundAdapter } from './adapters/whatsapp-official/whatsapp-official.inbound-adapter';
import { WhatsAppOfficialOutboundAdapter } from './adapters/whatsapp-official/whatsapp-official.outbound-adapter';
import { InstagramModule } from './adapters/instagram/instagram.module';
import { InstagramInboundAdapter } from './adapters/instagram/instagram.inbound-adapter';
import { InstagramOutboundAdapter } from './adapters/instagram/instagram.outbound-adapter';
import { InstagramSyncAdapter } from './adapters/instagram/instagram.sync-adapter';
import { GmailModule } from './adapters/gmail/gmail.module';
import { GmailInboundAdapter } from './adapters/gmail/gmail.inbound-adapter';
import { GmailOutboundAdapter } from './adapters/gmail/gmail.outbound-adapter';
import { ChannelSyncOrchestrator } from './sync/channel-sync.orchestrator';
import { ChannelSyncProcessor } from './sync/channel-sync.processor';
import { CHANNEL_SYNC_QUEUE } from './sync/channel-sync.constants';
import { MessagingModule } from '../messaging/messaging.module';
import { WebhookEventsService } from './webhook-events.service';
import { WebhookThrottleGuard } from './webhook-throttle.guard';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'inbound-messages' },
      { name: 'outbound-messages' },
      { name: 'notifications' },
      { name: 'media-processor' },
      { name: 'chatbot-processor' },
      { name: 'conversation-router' },
      { name: 'sla-timers' },
      { name: CHANNEL_SYNC_QUEUE },
    ),
    ZappfyModule,
    WhatsAppOfficialModule,
    InstagramModule,
    GmailModule,
    forwardRef(() => MessagingModule),
  ],
  controllers: [WebhookGatewayController, ChannelsController],
  providers: [
    ChannelAdapterRegistry,
    ChannelsService,
    ChannelsRepository,
    ChannelSyncOrchestrator,
    ChannelSyncProcessor,
    WebhookEventsService,
    WebhookThrottleGuard,
  ],
  exports: [
    ChannelAdapterRegistry,
    ChannelsService,
    ChannelSyncOrchestrator,
    WebhookEventsService,
    InstagramModule,
    ZappfyModule,
    GmailModule,
  ],
})
export class ChannelHubModule implements OnModuleInit {
  constructor(
    private readonly registry: ChannelAdapterRegistry,
    private readonly zappfyInbound: ZappfyInboundAdapter,
    private readonly zappfyOutbound: ZappfyOutboundAdapter,
    private readonly zappfySync: ZappfySyncAdapter,
    private readonly waOfficialInbound: WhatsAppOfficialInboundAdapter,
    private readonly waOfficialOutbound: WhatsAppOfficialOutboundAdapter,
    private readonly instagramInbound: InstagramInboundAdapter,
    private readonly instagramOutbound: InstagramOutboundAdapter,
    private readonly instagramSync: InstagramSyncAdapter,
    private readonly gmailInbound: GmailInboundAdapter,
    private readonly gmailOutbound: GmailOutboundAdapter,
  ) {}

  onModuleInit() {
    this.registry.register(this.zappfyInbound, this.zappfyOutbound);
    this.registry.register(this.waOfficialInbound, this.waOfficialOutbound);
    this.registry.register(this.instagramInbound, this.instagramOutbound);
    this.registry.register(this.gmailInbound, this.gmailOutbound);
    this.registry.registerHistorySync(this.zappfySync);
    this.registry.registerHistorySync(this.instagramSync);
  }
}
