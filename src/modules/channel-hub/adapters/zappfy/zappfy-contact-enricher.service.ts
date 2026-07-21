import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { ZappfyHttpClient } from './zappfy.http-client';
import { UploadsService } from '../../../messaging/messages/uploads.service';

/**
 * Pulls profile picture (and best-effort name) for a WhatsApp contact via
 * the Zappfy/uazapi `/chat/find` endpoint. Called lazily on inbound: if
 * the contact already has avatarUrl, we skip — saves a roundtrip per
 * incoming message.
 */
@Injectable()
export class ZappfyContactEnricherService {
  private readonly logger = new Logger(ZappfyContactEnricherService.name);
  /** Depois disso a cópia local da foto é considerada velha e rebuscada. */
  private static readonly AVATAR_TTL_DAYS = 7;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpClient: ZappfyHttpClient,
    private readonly uploads: UploadsService,
  ) {}

  async enrich(
    channel: Channel,
    externalContactId: string,
    force = false,
  ): Promise<void> {
    try {
      const contactChannel = await this.prisma.contactChannel.findUnique({
        where: {
          uq_contact_channel_external: {
            channelId: channel.id,
            externalId: externalContactId,
          },
        },
        include: { contact: true },
      });
      if (!contactChannel) return;

      // Rebusca quando: nunca teve foto, o arquivo sumiu (redeploy limpa o
      // diretório, que não é volume) ou a cópia local já passou do prazo.
      const ageDays = this.uploads.avatarAgeInDays(
        contactChannel.contact.avatarUrl,
      );
      const stale =
        ageDays === null || ageDays > ZappfyContactEnricherService.AVATAR_TTL_DAYS;
      if (contactChannel.contact.avatarUrl && !stale && !force) return;

      const chat = await this.fetchChat(channel, externalContactId);
      if (!chat) return;

      // `wa_profilePicUrl` NÃO existe na resposta do Zappfy — era isso que
      // deixava todo mundo sem foto. Os campos reais são `image` (original)
      // e `imagePreview` (reduzido). O /chat/find nem sempre traz uma URL
      // válida, então baixamos via /chat/details, que revalida.
      const profileName: string | undefined =
        chat.wa_contactName || chat.wa_name || undefined;
      const avatarUrl = await this.downloadAvatar(
        channel,
        externalContactId,
        contactChannel.contactId,
      );

      if (!avatarUrl && !profileName) return;

      const ccUpdates: Record<string, any> = {};
      if (profileName && profileName !== contactChannel.profileName) {
        ccUpdates.profileName = profileName;
      }
      if (avatarUrl && avatarUrl !== contactChannel.profileAvatarUrl) {
        ccUpdates.profileAvatarUrl = avatarUrl;
      }
      if (Object.keys(ccUpdates).length > 0) {
        await this.prisma.contactChannel.update({
          where: { id: contactChannel.id },
          data: ccUpdates,
        });
      }

      const contactUpdates: Record<string, any> = {};
      if (profileName && !contactChannel.contact.name) {
        contactUpdates.name = profileName;
      }
      if (avatarUrl && !contactChannel.contact.avatarUrl) {
        contactUpdates.avatarUrl = avatarUrl;
      }
      if (Object.keys(contactUpdates).length > 0) {
        await this.prisma.contact.update({
          where: { id: contactChannel.contactId },
          data: contactUpdates,
        });
      }

      this.logger.log(
        `Zappfy contact enriched: ${externalContactId} → ${profileName ?? '(no name)'} ${avatarUrl ? '+ avatar' : ''}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Zappfy contact enrichment failed for ${externalContactId}: ${err.message}`,
      );
    }
  }

  /**
   * Busca a foto no provider e guarda no nosso storage, devolvendo a URL
   * local. Servimos do nosso domínio porque a URL do WhatsApp vence em ~10
   * dias (e aí o `<img>` do cliente tomaria 403).
   */
  private async downloadAvatar(
    channel: Channel,
    externalContactId: string,
    contactId: string,
  ): Promise<string | undefined> {
    try {
      const { url } = await this.httpClient.fetchProfilePicture(
        channel,
        externalContactId.replace(/@s\.whatsapp\.net$/, ''),
      );
      if (!url) return undefined;
      const buffer = await this.httpClient.getMediaBuffer(channel, url);
      if (!buffer?.byteLength) return undefined;
      return await this.uploads.saveAvatar({
        key: contactId,
        buffer,
        mimeType: 'image/jpeg',
      });
    } catch (err: any) {
      // Contato sem foto, foto restrita por privacidade ou provider fora:
      // seguimos sem avatar, a UI cai nas iniciais.
      this.logger.debug(
        `Sem avatar pra ${externalContactId}: ${err.message}`,
      );
      return undefined;
    }
  }

  private async fetchChat(
    channel: Channel,
    chatId: string,
  ): Promise<any | null> {
    // /chat/find aceita filtros — passamos wa_chatid pra buscar o chat
    // exato e ler wa_profilePicUrl + wa_contactName / wa_name.
    try {
      const response = await this.httpClient.sendRequest(
        channel,
        '/chat/find',
        { wa_chatid: chatId, limit: 1 },
      );
      const chats = response?.chats ?? response?.data ?? response;
      return Array.isArray(chats) ? chats[0] : chats?.[0] ?? null;
    } catch (err: any) {
      this.logger.warn(
        `Zappfy fetchChat failed for ${chatId}: ${err.message}`,
      );
      return null;
    }
  }
}
