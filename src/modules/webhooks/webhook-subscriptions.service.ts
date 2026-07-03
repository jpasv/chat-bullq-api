import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { AutomationTrigger } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { WEBHOOK_QUEUE, MAX_WEBHOOK_ATTEMPTS, WEBHOOK_BACKOFF_MS, WEBHOOK_SECRET_PREFIX } from './webhooks.constants';

@Injectable()
export class WebhookSubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
  ) {}

  private generateSecret(): string {
    return WEBHOOK_SECRET_PREFIX + crypto.randomBytes(24).toString('base64url');
  }

  async create(
    organizationId: string,
    createdById: string | null,
    input: { url: string; events: AutomationTrigger[]; description?: string },
  ) {
    return this.prisma.webhookSubscription.create({
      data: {
        organizationId,
        createdById,
        url: input.url,
        events: input.events,
        description: input.description ?? null,
        secret: this.generateSecret(),
      },
    });
  }

  async findAll(organizationId: string) {
    return this.prisma.webhookSubscription.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, organizationId: string) {
    const sub = await this.prisma.webhookSubscription.findFirst({ where: { id, organizationId } });
    if (!sub) throw new NotFoundException('Webhook subscription not found');
    return sub;
  }

  async update(
    id: string,
    organizationId: string,
    input: { url?: string; events?: AutomationTrigger[]; isActive?: boolean; description?: string },
  ) {
    await this.findOne(id, organizationId);
    const data: any = { ...input };
    if (input.isActive === true) {
      data.consecutiveFailures = 0;
      data.disabledAt = null;
    }
    return this.prisma.webhookSubscription.update({ where: { id }, data });
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    await this.prisma.webhookSubscription.delete({ where: { id } });
    return { deleted: true };
  }

  async listDeliveries(id: string, organizationId: string, page: number, limit: number) {
    await this.findOne(id, organizationId);
    const skip = (page - 1) * limit;
    const [deliveries, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where: { subscriptionId: id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.webhookDelivery.count({ where: { subscriptionId: id } }),
    ]);
    return { deliveries, total };
  }

  async ping(id: string, organizationId: string) {
    const sub = await this.findOne(id, organizationId);
    const delivery = await this.prisma.webhookDelivery.create({
      data: { subscriptionId: sub.id, type: 'PING', payload: { ping: true } },
    });
    await this.queue.add(
      'deliver',
      { deliveryId: delivery.id },
      { attempts: MAX_WEBHOOK_ATTEMPTS, backoff: { type: 'exponential', delay: WEBHOOK_BACKOFF_MS }, removeOnComplete: true, removeOnFail: false },
    );
    return { queued: true };
  }
}
