import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ChannelHubModule } from '../channel-hub/channel-hub.module';
import { RatingsModule } from '../ratings/ratings.module';
import { AiAgentsModule } from '../ai-agents/ai-agents.module';
import { WatchdogModule } from '../routing/watchdog/watchdog.module';
import { SegmentsModule } from '../segments/segments.module';
import { ProjectsModule } from '../projects/projects.module';
import { SalesRecoveryModule } from '../sales-recovery/sales-recovery.module';
import { IdempotencyService } from './pipeline/idempotency.service';
import { ContactResolverService } from './pipeline/contact-resolver.service';
import { ConversationResolverService } from './pipeline/conversation-resolver.service';
import { HistoryImportService } from './pipeline/history-import.service';
import { InboundMessageProcessor } from './pipeline/inbound-message.processor';
import { OutboundMessageProcessor } from './pipeline/outbound-message.processor';
import { ConversationFsmService } from './conversations/conversation-fsm.service';
import { ConversationsController } from './conversations/conversations.controller';
import { ConversationsService } from './conversations/conversations.service';
import { ConversationsRepository } from './conversations/conversations.repository';
import { MessagesController } from './messages/messages.controller';
import { MessagesService } from './messages/messages.service';
import { MessagesRepository } from './messages/messages.repository';
import { TranscriptionService } from './messages/transcription.service';
import { UploadsService } from './messages/uploads.service';
import { MediaResolverService } from './messages/media-resolver.service';
import { AudioSourceService } from './messages/audio-source.service';
import { PlaybackService } from './messages/playback.service';
import { ContactsController } from './contacts/contacts.controller';
import { ContactsService } from './contacts/contacts.service';
import { ContactsRepository } from './contacts/contacts.repository';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'inbound-messages' },
      { name: 'outbound-messages' },
      { name: 'chatbot-processor' },
    ),
    forwardRef(() => ChannelHubModule),
    RatingsModule,
    AiAgentsModule,
    WatchdogModule,
    SegmentsModule,
    ProjectsModule,
    SalesRecoveryModule,
  ],
  controllers: [ConversationsController, MessagesController, ContactsController],
  providers: [
    IdempotencyService,
    ContactResolverService,
    ConversationResolverService,
    HistoryImportService,
    InboundMessageProcessor,
    OutboundMessageProcessor,
    ConversationFsmService,
    ConversationsService,
    ConversationsRepository,
    MessagesService,
    MessagesRepository,
    TranscriptionService,
    UploadsService,
    MediaResolverService,
    AudioSourceService,
    PlaybackService,
    ContactsService,
    ContactsRepository,
  ],
  exports: [ConversationsService, MessagesService, ConversationFsmService, ContactsService, HistoryImportService, UploadsService],
})
export class MessagingModule {}
