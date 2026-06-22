import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { SalesRecoveryService } from '../sales-recovery.service';
import { RecoveryConfigService } from '../recovery-config.service';
import { KirvanoEventsService } from './kirvano-events.service';
import { normalizeKirvano } from './kirvano-payload';
import { KIRVANO_EVENTS_QUEUE } from '../sales-recovery.constants';

interface KirvanoJobData {
  kirvanoEventId: string;
}

/**
 * Processa o webhook gravado: normaliza, resolve org+canal, valida produto
 * rastreado e roteia pro service (criar/ganhar/reembolsar card). Marca o
 * KirvanoEvent como PROCESSED/IGNORED/FAILED no fim — auditável e replay-safe.
 */
@Processor(KIRVANO_EVENTS_QUEUE, { concurrency: 4 })
export class KirvanoEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(KirvanoEventsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: KirvanoEventsService,
    private readonly recovery: SalesRecoveryService,
    private readonly config: RecoveryConfigService,
  ) {
    super();
  }

  async process(job: Job<KirvanoJobData>): Promise<any> {
    const { kirvanoEventId } = job.data;
    const record = await this.prisma.kirvanoEvent.findUnique({
      where: { id: kirvanoEventId },
    });
    if (!record) {
      this.logger.warn(`KirvanoEvent ${kirvanoEventId} sumiu — skip`);
      return;
    }

    const k = normalizeKirvano(record.payload);

    // Org/canal de outreach (1 org por enquanto). Sem config → falha explícita.
    const organizationId = this.config.orgId;
    const channelId = this.config.outreachChannelId;
    if (!organizationId || !channelId) {
      await this.events.markFailed(
        record.id,
        'RECOVERY_ORG_ID/RECOVERY_OUTREACH_CHANNEL_ID não configurados',
      );
      return;
    }

    // Produto fora da lista rastreada → ignora (sem ação).
    if (!this.config.isProductTracked(k.productUuid)) {
      await this.events.markIgnored(
        record.id,
        `produto não rastreado: ${k.productUuid}`,
      );
      return;
    }

    try {
      let result;
      switch (k.category) {
        case 'create':
          result = await this.recovery.createOpportunity(
            organizationId,
            channelId,
            k,
          );
          break;
        case 'won':
          result = await this.recovery.closeWon(organizationId, k);
          break;
        case 'refund':
          result = await this.recovery.closeRefunded(organizationId, k);
          break;
        default:
          await this.events.markIgnored(record.id, `evento sem ação: ${k.event}`);
          return;
      }

      if (result.status === 'no_card') {
        await this.events.markIgnored(
          record.id,
          `sem card pra ${k.event} (sale=${k.saleId})`,
        );
      } else {
        await this.events.markProcessed(record.id, organizationId);
      }
      this.logger.log(
        `Kirvano ${k.event} → ${result.status} (card=${result.cardId ?? '-'})`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Falha processando Kirvano ${record.id}: ${msg}`);
      await this.events.markFailed(record.id, msg);
      throw err; // deixa o BullMQ tentar de novo
    }
  }
}
