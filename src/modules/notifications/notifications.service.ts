import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationType } from '@prisma/client';
import { NotificationsRepository } from './notifications.repository';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly repository: NotificationsRepository,
    private readonly prisma: PrismaService,
    @InjectQueue('notifications') private readonly notifQueue: Queue,
  ) {}

  async notify(params: {
    recipientId: string;
    organizationId: string;
    type: NotificationType;
    title: string;
    body: string;
    data?: Record<string, any>;
  }) {
    const notification = await this.repository.create({
      recipientId: params.recipientId,
      organizationId: params.organizationId,
      type: params.type,
      title: params.title,
      body: params.body,
      data: params.data || {},
    });

    await this.notifQueue.add('deliver', {
      notificationId: notification.id,
      recipientId: params.recipientId,
      organizationId: params.organizationId,
      type: params.type,
      title: params.title,
      body: params.body,
      data: params.data,
    });

    return notification;
  }

  async notifyOrgAgents(params: {
    organizationId: string;
    excludeUserId?: string;
    type: NotificationType;
    title: string;
    body: string;
    data?: Record<string, any>;
  }) {
    const members = await this.prisma.userOrganization.findMany({
      where: { organizationId: params.organizationId },
      select: { userId: true },
    });

    const recipients = members
      .map((m) => m.userId)
      .filter((id) => id !== params.excludeUserId);

    for (const recipientId of recipients) {
      await this.notify({
        recipientId,
        organizationId: params.organizationId,
        type: params.type,
        title: params.title,
        body: params.body,
        data: params.data,
      });
    }
  }

  async findByUser(userId: string, orgId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const { notifications, total } = await this.repository.findByUser(userId, orgId, skip, limit);
    const unreadCount = await this.repository.countUnread(userId, orgId);
    return {
      notifications,
      unreadCount,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async markRead(id: string, userId: string, orgId: string) {
    const result = await this.repository.markRead(id, userId, orgId);
    if (result.count === 0) throw new NotFoundException('Notification not found');
    return result;
  }

  async markAllRead(userId: string, orgId: string) {
    return this.repository.markAllRead(userId, orgId);
  }

  async getUnreadCount(userId: string, orgId: string) {
    return this.repository.countUnread(userId, orgId);
  }
}
