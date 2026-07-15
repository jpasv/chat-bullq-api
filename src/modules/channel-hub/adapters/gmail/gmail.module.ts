import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GmailAuthService } from './gmail-auth.service';
import { GmailHttpClient } from './gmail.http-client';
import { GmailMessageMapper } from './gmail.message-mapper';
import { GmailInboundAdapter } from './gmail.inbound-adapter';
import { GmailOutboundAdapter } from './gmail.outbound-adapter';
import { GmailPollingCron } from './gmail-polling.cron';
import { GMAIL_POLL_QUEUE } from './gmail.constants';
import { MessagingModule } from '../../../messaging/messaging.module';

@Module({
  imports: [
    // UploadsService (re-host de anexos) vive no MessagingModule — mesmo
    // forwardRef do WhatsAppOfficialModule (ciclo channel-hub ↔ messaging).
    forwardRef(() => MessagingModule),
    BullModule.registerQueue(
      { name: GMAIL_POLL_QUEUE },
      { name: 'inbound-messages' },
    ),
  ],
  providers: [
    GmailAuthService,
    GmailHttpClient,
    GmailMessageMapper,
    GmailInboundAdapter,
    GmailOutboundAdapter,
    GmailPollingCron,
  ],
  exports: [
    GmailInboundAdapter,
    GmailOutboundAdapter,
    GmailHttpClient,
    GmailAuthService,
  ],
})
export class GmailModule {}
