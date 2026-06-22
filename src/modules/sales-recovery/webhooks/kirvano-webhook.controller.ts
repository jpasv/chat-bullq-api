import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Public } from '../../../common/decorators';
import { RecoveryConfigService } from '../recovery-config.service';
import { KirvanoEventsService } from './kirvano-events.service';
import { normalizeKirvano } from './kirvano-payload';
import { KIRVANO_EVENTS_QUEUE } from '../sales-recovery.constants';

/**
 * Recebe os webhooks da Kirvano. Público (sem JWT) — a autenticação é o
 * segredo na URL (`/webhooks/kirvano/<secret>`), porque a Kirvano não assina
 * o payload com header. Responde 200 rápido e processa de forma assíncrona.
 */
@ApiTags('Webhooks')
@Controller('webhooks/kirvano')
export class KirvanoWebhookController {
  private readonly logger = new Logger(KirvanoWebhookController.name);

  constructor(
    private readonly config: RecoveryConfigService,
    private readonly events: KirvanoEventsService,
    @InjectQueue(KIRVANO_EVENTS_QUEUE) private readonly queue: Queue,
  ) {}

  @Post(':secret')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Recebe webhook de venda/cobrança da Kirvano' })
  @ApiParam({ name: 'secret', description: 'Segredo configurado na URL' })
  async handle(
    @Param('secret') secret: string,
    @Body() payload: any,
    @Headers() headers: Record<string, string>,
  ): Promise<{ status: string }> {
    const expected = this.config.webhookSecret;
    if (!expected || secret !== expected) {
      this.logger.warn('Kirvano webhook com segredo inválido');
      throw new UnauthorizedException('invalid secret');
    }

    const k = normalizeKirvano(payload);

    // Log append-only: grava TODA entrega (com headers), inclusive sem event
    // ou duplicada. Nada de webhook é perdido.
    const record = await this.events.record(
      k.event || 'UNKNOWN',
      k.productUuid,
      k.saleId,
      k.checkoutId,
      payload,
      headers,
    );

    if (!k.event) {
      await this.events.markIgnored(record.id, 'webhook sem campo event');
      return { status: 'no_event' };
    }

    await this.queue.add(
      'process-kirvano-event',
      { kirvanoEventId: record.id },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(
      `Kirvano webhook recebido: event=${k.event} sale=${k.saleId} → ${record.id}`,
    );
    return { status: 'ok' };
  }
}
