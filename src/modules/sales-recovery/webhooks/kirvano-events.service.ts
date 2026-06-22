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
   * Persiste o evento. Retorna o registro, ou `null` se já existe um com o
   * mesmo (event, sale_id) — nesse caso é replay/duplicado e não reprocessa.
   */
  async record(
    event: string,
    productUuid: string | null,
    saleId: string | null,
    checkoutId: string | null,
    payload: unknown,
    headers: unknown,
  ): Promise<KirvanoEvent | null> {
    try {
      return await this.prisma.kirvanoEvent.create({
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
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log(
          `Kirvano webhook duplicado ignorado: event=${event} sale=${saleId}`,
        );
        return null;
      }
      throw err;
    }
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
