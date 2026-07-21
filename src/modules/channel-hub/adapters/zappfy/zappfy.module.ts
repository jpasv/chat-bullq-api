import { Module, forwardRef } from '@nestjs/common';
import { ZappfyInboundAdapter } from './zappfy.inbound-adapter';
import { ZappfyOutboundAdapter } from './zappfy.outbound-adapter';
import { ZappfyMessageMapper } from './zappfy.message-mapper';
import { ZappfyHttpClient } from './zappfy.http-client';
import { ZappfySyncAdapter } from './zappfy.sync-adapter';
import { ZappfyContactEnricherService } from './zappfy-contact-enricher.service';
import { MessagingModule } from '../../../messaging/messaging.module';

@Module({
  imports: [
    // O enricher re-hospeda a foto de perfil pelo UploadsService, que vive no
    // MessagingModule — mesmo forwardRef do Gmail/WhatsApp oficial (ciclo
    // channel-hub ↔ messaging).
    forwardRef(() => MessagingModule),
  ],
  providers: [
    ZappfyInboundAdapter,
    ZappfyOutboundAdapter,
    ZappfyMessageMapper,
    ZappfyHttpClient,
    ZappfySyncAdapter,
    ZappfyContactEnricherService,
  ],
  exports: [
    ZappfyInboundAdapter,
    ZappfyOutboundAdapter,
    ZappfyHttpClient,
    ZappfySyncAdapter,
    ZappfyContactEnricherService,
  ],
})
export class ZappfyModule {}
