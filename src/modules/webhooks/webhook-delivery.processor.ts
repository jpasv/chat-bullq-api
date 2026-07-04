import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import axios from 'axios';
import { NotificationType, WebhookDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WEBHOOK_QUEUE, WEBHOOK_AUTO_DISABLE_AFTER, WEBHOOK_TIMEOUT_MS } from './webhooks.constants';
import { signPayload } from './hmac.util';

@Processor(WEBHOOK_QUEUE, { concurrency: 8 })
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<{ deliveryId: string }>): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: job.data.deliveryId },
      include: { subscription: true },
    });
    if (!delivery) return;
    const sub = (delivery as any).subscription;
    if (!sub || !sub.isActive) {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: WebhookDeliveryStatus.DLQ, lastError: 'subscription inactive' },
      });
      return;
    }

    const body = JSON.stringify({
      id: delivery.id,
      type: delivery.type,
      createdAt: delivery.createdAt.toISOString(),
      organizationId: sub.organizationId,
      data: delivery.payload,
    });

    try {
      const res = await axios.post(sub.url, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-BullQ-Event': delivery.type,
          'X-BullQ-Delivery': delivery.id,
          'X-BullQ-Signature': signPayload(body, sub.secret),
        },
        timeout: WEBHOOK_TIMEOUT_MS,
        validateStatus: () => true,
      });

      const status = res.status ?? 0;
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.SUCCESS,
          responseStatus: status,
          deliveredAt: new Date(),
          attemptCount: (job.attemptsMade ?? 0) + 1,
        },
      });
      await this.prisma.webhookSubscription.update({ where: { id: sub.id }, data: { consecutiveFailures: 0 } });
    } catch (err) {
      const msg = (err as Error).message;
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: WebhookDeliveryStatus.FAILED, lastError: msg.slice(0, 500), attemptCount: (job.attemptsMade ?? 0) + 1 },
      });
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ deliveryId: string }>) {
    if ((job.attemptsMade ?? 0) < (job.opts?.attempts ?? 1)) return;
    await this.handleExhausted(job.data.deliveryId);
  }

  async handleExhausted(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) return;
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: WebhookDeliveryStatus.DLQ },
    });

    const sub = await this.prisma.webhookSubscription.findUnique({ where: { id: delivery.subscriptionId } });
    if (!sub) return;
    const failures = (sub.consecutiveFailures ?? 0) + 1;

    if (failures >= WEBHOOK_AUTO_DISABLE_AFTER) {
      await this.prisma.webhookSubscription.update({
        where: { id: sub.id },
        data: { consecutiveFailures: failures, isActive: false, disabledAt: new Date() },
      });
      await this.notifications.notifyOrgAgents({
        organizationId: sub.organizationId,
        type: NotificationType.SYSTEM,
        title: 'Webhook desativado',
        body: `O webhook ${sub.url} foi desativado após ${failures} falhas consecutivas.`,
        data: { subscriptionId: sub.id },
      });
    } else {
      await this.prisma.webhookSubscription.update({ where: { id: sub.id }, data: { consecutiveFailures: failures } });
    }
  }
}
