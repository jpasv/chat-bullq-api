import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

interface WaOfficialConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  apiVersion?: string;
}

@Injectable()
export class WhatsAppOfficialHttpClient {
  private readonly logger = new Logger(WhatsAppOfficialHttpClient.name);

  private getConfig(channel: Channel): WaOfficialConfig {
    const config = channel.config as Record<string, any>;
    return {
      accessToken: config.accessToken,
      phoneNumberId: config.phoneNumberId,
      businessAccountId: config.businessAccountId,
      apiVersion: config.apiVersion || 'v21.0',
    };
  }

  private createClient(channel: Channel): AxiosInstance {
    const cfg = this.getConfig(channel);
    return axios.create({
      baseURL: `https://graph.facebook.com/${cfg.apiVersion}`,
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
      timeout: 30000,
    });
  }

  async sendMessage(
    channel: Channel,
    payload: Record<string, any>,
  ): Promise<any> {
    const cfg = this.getConfig(channel);
    const client = this.createClient(channel);
    try {
      const { data } = await client.post(
        `/${cfg.phoneNumberId}/messages`,
        payload,
      );
      return data;
    } catch (error: any) {
      this.logger.error(
        `WA Official API error: ${error.response?.data?.error?.message || error.message}`,
      );
      throw error;
    }
  }

  async getMediaUrl(channel: Channel, mediaId: string): Promise<string> {
    const client = this.createClient(channel);
    const { data } = await client.get(`/${mediaId}`);
    return data.url;
  }

  async downloadMedia(channel: Channel, url: string): Promise<Buffer> {
    const cfg = this.getConfig(channel);
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(response.data);
  }

  async verifyPhoneNumber(channel: Channel): Promise<any> {
    const cfg = this.getConfig(channel);
    const client = this.createClient(channel);
    try {
      const { data } = await client.get(`/${cfg.phoneNumberId}`);
      return data;
    } catch (error: any) {
      this.logger.error(`WA Official verify failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Subscribes our app to receive webhooks for this WABA. Idempotent on
   * Meta's side — re-calling is safe. Requires `whatsapp_business_management`
   * scope on the access token.
   */
  async subscribeApp(channel: Channel): Promise<any> {
    const cfg = this.getConfig(channel);
    if (!cfg.businessAccountId) {
      throw new Error('businessAccountId required to subscribe app');
    }
    const client = this.createClient(channel);
    const { data } = await client.post(`/${cfg.businessAccountId}/subscribed_apps`);
    return data;
  }

  /**
   * Templates HSM aprovados da WABA — obrigatórios pra iniciar conversa fora
   * da janela de 24h (cold start). Só retorna os com `status: APPROVED`;
   * templates pendentes/rejeitados pela Meta não são utilizáveis.
   */
  async listTemplates(channel: Channel): Promise<
    Array<{
      name: string;
      language: string;
      components: Array<Record<string, any>>;
    }>
  > {
    const cfg = this.getConfig(channel);
    if (!cfg.businessAccountId) {
      throw new Error('businessAccountId required to list templates');
    }
    const client = this.createClient(channel);
    const { data } = await client.get(
      `/${cfg.businessAccountId}/message_templates`,
      { params: { fields: 'name,status,language,components', limit: 100 } },
    );
    return (data?.data ?? [])
      .filter((t: any) => t.status === 'APPROVED')
      .map((t: any) => ({
        name: t.name,
        language: t.language,
        components: t.components ?? [],
      }));
  }
}
