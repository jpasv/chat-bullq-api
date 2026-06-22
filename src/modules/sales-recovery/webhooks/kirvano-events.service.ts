import { Injectable, Logger } from '@nestjs/common';
import { KirvanoEvent, KirvanoEventStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

/**
 * Grava todo webhook da Kirvano (append-only, source-of-truth pra replay) e
 * garante idempotência por (event, sale_id). Espelha o WebhookEventsService.
 */
@Injectable()
export class KirvanoEventsService {
  private readonly logger = new Logger(KirvanoEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persiste o evento (append-only — registra TODA entrega, inclusive
   * retries/duplicadas). A idempotência de ação fica no processor + guards
   * de card. Sempre retorna o registro criado.
   */
  async record(
    event: string,
    productUuid: string | null,
    saleId: string | null,
    checkoutId: string | null,
    payload: unknown,
    headers: unknown,
  ): Promise<KirvanoEvent> {
    return this.prisma.kirvanoEvent.create({
      data: {
        event,
        productUuid,
        saleId,
        checkoutId,
        payload: (payload ?? {}) as Prisma.InputJsonValue,
        headers: (headers ?? {}) as Prisma.InputJsonValue,
        status: KirvanoEventStatus.RECEIVED,
      },
    });
  }

  /**
   * Já existe uma entrega PROCESSED com o mesmo (event, sale_id)? Usado pelo
   * processor pra não reprocessar retries (idempotência de ação).
   */
  async alreadyProcessed(
    id: string,
    event: string,
    saleId: string | null,
  ): Promise<boolean> {
    if (!saleId) return false;
    const prior = await this.prisma.kirvanoEvent.findFirst({
      where: {
        id: { not: id },
        event,
        saleId,
        status: KirvanoEventStatus.PROCESSED,
      },
      select: { id: true },
    });
    return !!prior;
  }

  async markDuplicate(id: string): Promise<void> {
    await this.prisma.kirvanoEvent.update({
      where: { id },
      data: { status: KirvanoEventStatus.DUPLICATE, processedAt: new Date() },
    });
  }

  async markProcessed(id: string, organizationId?: string): Promise<void> {
    await this.prisma.kirvanoEvent.update({
      where: { id },
      data: {
        status: KirvanoEventStatus.PROCESSED,
        organizationId,
        processedAt: new Date(),
      },
    });
  }

  async markIgnored(id: string, reason?: string): Promise<void> {
    await this.prisma.kirvanoEvent.update({
      where: { id },
      data: {
        status: KirvanoEventStatus.IGNORED,
        errorMessage: reason,
        processedAt: new Date(),
      },
    });
  }

  async markFailed(id: string, message: string): Promise<void> {
    await this.prisma.kirvanoEvent.update({
      where: { id },
      data: { status: KirvanoEventStatus.FAILED, errorMessage: message },
    });
  }
}
