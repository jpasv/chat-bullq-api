import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class ZappfyHttpClient {
  private static readonly BASE_URL = 'https://api.zappfy.io';
  private readonly logger = new Logger(ZappfyHttpClient.name);

  private createClient(channel: Channel): AxiosInstance {
    const config = channel.config as Record<string, any>;
    return axios.create({
      baseURL: ZappfyHttpClient.BASE_URL,
      headers: { token: config.token },
      timeout: 30000,
    });
  }

  async sendRequest(
    channel: Channel,
    endpoint: string,
    payload: Record<string, any>,
  ): Promise<any> {
    const client = this.createClient(channel);
    try {
      const response = await client.post(endpoint, payload);
      return response.data;
    } catch (error: any) {
      this.logger.error(
        `Zappfy API error: ${endpoint} - ${error.response?.data?.message || error.message}`,
      );
      throw error;
    }
  }

  async getInstanceStatus(channel: Channel): Promise<any> {
    const client = this.createClient(channel);
    try {
      const response = await client.get('/instance/status');
      return response.data;
    } catch (error: any) {
      this.logger.error(`Zappfy status check failed: ${error.message}`);
      throw error;
    }
  }

  async fetchChats(
    channel: Channel,
    options: { limit?: number; offset?: number; isGroup?: boolean } = {},
  ): Promise<any> {
    return this.sendRequest(channel, '/chat/find', {
      sort: '-wa_lastMsgTimestamp',
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      ...(options.isGroup !== undefined && { wa_isGroup: options.isGroup }),
    });
  }

  async fetchMessages(
    channel: Channel,
    chatId: string,
    limit = 50,
    offset = 0,
  ): Promise<any> {
    return this.sendRequest(channel, '/message/find', {
      chatid: chatId,
      limit,
      offset,
    });
  }

  /**
   * Foto de perfil de um contato ou grupo, com o nome de exibição de brinde.
   *
   * Detalhe que custou caro: sem mandar `preview` no corpo, o Zappfy devolve
   * a URL que ele tem em cache, que costuma estar vencida (o CDN responde
   * 403). Mandando o campo, ele revalida e devolve uma URL boa por ~10 dias.
   * Serve tanto pra número (`5545...`) quanto pra JID de grupo (`...@g.us`).
   */
  async fetchProfilePicture(
    channel: Channel,
    numberOrJid: string,
  ): Promise<{ url: string | null; name: string | null }> {
    const chat = await this.sendRequest(channel, '/chat/details', {
      number: numberOrJid,
      preview: false,
    });
    return {
      url: chat?.image || chat?.imagePreview || null,
      name: chat?.wa_contactName || chat?.wa_name || chat?.name || null,
    };
  }

  /**
   * Participantes de um grupo. O Zappfy devolve cada um com LID e telefone
   * (`DisplayName` vem vazio na prática), então quem resolve o nome é o
   * caller, cruzando o telefone com os contatos que já temos.
   */
  async fetchGroupParticipants(
    channel: Channel,
    groupJid: string,
  ): Promise<Array<{ phone: string; lid?: string; isAdmin: boolean }>> {
    const info = await this.sendRequest(channel, '/group/info', {
      groupjid: groupJid,
    });
    const participants = info?.Participants ?? info?.participants ?? [];
    return participants
      .map((p: any) => ({
        phone: String(p?.PhoneNumber ?? '').replace(/@.*$/, ''),
        lid: p?.LID ?? p?.JID ?? undefined,
        isAdmin: !!(p?.IsAdmin || p?.IsSuperAdmin),
      }))
      .filter((p: { phone: string }) => !!p.phone);
  }

  async configureWebhook(
    channel: Channel,
    url: string,
    events = ['messages', 'messages_update'],
  ): Promise<any> {
    return this.sendRequest(channel, '/webhook', {
      enabled: true,
      url,
      events,
    });
  }

  async getMediaBuffer(
    channel: Channel,
    mediaUrl: string,
  ): Promise<Buffer> {
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(response.data);
  }

  /**
   * Inbound media from WhatsApp is delivered as an encrypted .enc URL on
   * mmg.whatsapp.net that the browser cannot play. Uazapi exposes
   * /message/download which decrypts server-side and returns a playable
   * URL on their own CDN. We hit that, then the caller can either redirect
   * clients to it or fetch bytes for transcription.
   */
  async resolveInboundMediaUrl(
    channel: Channel,
    externalMessageId: string,
  ): Promise<{ fileUrl: string; mimeType?: string }> {
    const response = await this.sendRequest(channel, '/message/download', {
      id: externalMessageId,
    });
    const fileUrl: string | undefined = response?.fileURL || response?.fileUrl;
    if (!fileUrl) {
      throw new Error(
        `Uazapi /message/download returned no fileURL for ${externalMessageId}`,
      );
    }
    return { fileUrl, mimeType: response?.mimetype };
  }

  /**
   * Apaga a mensagem pra todos no WhatsApp via Uazapi.
   * Endpoint: `POST /message/delete` com `{ id: <externalMessageId> }`.
   * Uazapi devolve 200 mesmo quando a janela do WhatsApp já passou (o
   * cliente final só vê "Esta mensagem foi apagada" se for recente —
   * limitação do próprio WhatsApp, não nossa).
   */
  async deleteMessage(
    channel: Channel,
    externalMessageId: string,
  ): Promise<void> {
    await this.sendRequest(channel, '/message/delete', {
      id: externalMessageId,
    });
  }
}
