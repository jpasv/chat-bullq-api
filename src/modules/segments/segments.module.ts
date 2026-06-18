import { Module } from '@nestjs/common';
import { SegmentLookupService } from './segment-lookup.service';
import { SegmentsService } from './segments.service';
import { SegmentsController } from './segments.controller';

/**
 * Segmentos: vários canais (números) que compartilham os mesmos grupos de
 * WhatsApp e o histórico. Exporta {@link SegmentLookupService} para o
 * pipeline de ingestão (MessagingModule) rotear as mensagens de grupo.
 */
@Module({
  controllers: [SegmentsController],
  providers: [SegmentLookupService, SegmentsService],
  exports: [SegmentLookupService],
})
export class SegmentsModule {}
