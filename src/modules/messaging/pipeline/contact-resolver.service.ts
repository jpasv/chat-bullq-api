import { Injectable, Logger } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { NormalizedInboundMessage } from '../../channel-hub/ports/types';
import { IdempotencyService } from './idempotency.service';

export interface ResolvedContact {
  contactId: string;
  contactChannelId: string;
  isNew: boolean;
}

@Injectable()
export class ContactResolverService {
  private readonly logger = new Logger(ContactResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async resolve(
    organizationId: string,
    channelId: string,
    message: NormalizedInboundMessage,
  ): Promise<ResolvedContact> {
    // Fast path: already exists, just refresh mutable fields.
    const existing = await this.prisma.contactChannel.findUnique({
      where: {
        uq_contact_channel_external: {
          channelId,
          externalId: message.externalContactId,
        },
      },
      include: { contact: true },
    });

    if (existing) {
      await this.applyProfileUpdates(existing, message);
      return {
        contactId: existing.contactId,
        contactChannelId: existing.id,
        isNew: false,
      };
    }

    // Slow path: needs insert. Serialise per (channel, externalId) to avoid
    // race between concurrent webhooks for the same brand-new contact.
    return this.idempotency.withLock(
      `contact:${channelId}:${message.externalContactId}`,
      async () => {
        // Re-check inside the lock — another worker may have just created it.
        const racer = await this.prisma.contactChannel.findUnique({
          where: {
            uq_contact_channel_external: {
              channelId,
              externalId: message.externalContactId,
            },
          },
          include: { contact: true },
        });
        if (racer) {
          await this.applyProfileUpdates(racer, message);
          return {
            contactId: racer.contactId,
            contactChannelId: racer.id,
            isNew: false,
          };
        }

        const contact = await this.prisma.contact.create({
          data: {
            organizationId,
            name: message.contactName,
            phone: message.contactPhone,
            // Em canais de email a identidade externa É o endereço — sem
            // isso o campo fica NULL e a IA pede ao cliente um email que
            // já está na conversa.
            email: emailIdentityOf(message),
            avatarUrl: message.contactAvatarUrl,
            channels: {
              create: {
                channelId,
                externalId: message.externalContactId,
                profileName: message.contactName,
                profileAvatarUrl: message.contactAvatarUrl,
              },
            },
          },
          include: { channels: true },
        });

        this.logger.log(
          `New contact created: ${contact.id} (${message.contactPhone || message.externalContactId})`,
        );

        return {
          contactId: contact.id,
          contactChannelId: contact.channels[0].id,
          isNew: true,
        };
      },
    );
  }

  private async applyProfileUpdates(
    existing: {
      id: string;
      profileName: string | null;
      profileAvatarUrl: string | null;
      contactId: string;
      contact: {
        name: string | null;
        phone: string | null;
        email: string | null;
      };
    },
    message: NormalizedInboundMessage,
  ): Promise<void> {
    const ccUpdates: Record<string, any> = {};
    if (message.contactName && message.contactName !== existing.profileName) {
      ccUpdates.profileName = message.contactName;
    }
    if (
      message.contactAvatarUrl &&
      message.contactAvatarUrl !== existing.profileAvatarUrl
    ) {
      ccUpdates.profileAvatarUrl = message.contactAvatarUrl;
    }
    if (Object.keys(ccUpdates).length > 0) {
      await this.prisma.contactChannel.update({
        where: { id: existing.id },
        data: ccUpdates,
      });
    }

    const contactUpdates: Record<string, any> = {};
    if (message.contactName && !existing.contact.name) {
      contactUpdates.name = message.contactName;
    }
    if (message.contactPhone && !existing.contact.phone) {
      contactUpdates.phone = message.contactPhone;
    }
    const emailIdentity = emailIdentityOf(message);
    if (emailIdentity && !existing.contact.email) {
      contactUpdates.email = emailIdentity;
    }
    if (Object.keys(contactUpdates).length > 0) {
      await this.prisma.contact.update({
        where: { id: existing.contactId },
        data: contactUpdates,
      });
    }
  }
}

/**
 * Endereço de email do contato quando a identidade externa do canal é um
 * email (GMAIL). NÃO usar "contém @" como heurística — JID de WhatsApp
 * também tem @ (5521...@s.whatsapp.net).
 */
function emailIdentityOf(
  message: NormalizedInboundMessage,
): string | undefined {
  return message.channelType === ChannelType.GMAIL
    ? message.externalContactId
    : undefined;
}
