import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

interface InstagramConfig {
  accessToken: string;
  igBusinessId?: string;
  appSecret?: string;
  apiVersion?: string;
}

@Injectable()
export class InstagramHttpClient {
  private readonly logger = new Logger(InstagramHttpClient.name);

  private getConfig(channel: Channel): InstagramConfig {
    const config = channel.config as Record<string, any>;
    return {
      accessToken: config.accessToken || config.pageAccessToken,
      igBusinessId: config.igBusinessId || config.igUserId,
      appSecret: config.appSecret,
      apiVersion: config.apiVersion || 'v21.0',
    };
  }

  private createClient(channel: Channel): AxiosInstance {
    const cfg = this.getConfig(channel);
    return axios.create({
      baseURL: `https://graph.instagram.com/${cfg.apiVersion}`,
      params: { access_token: cfg.accessToken },
      timeout: 30000,
    });
  }

  async getMe(channel: Channel): Promise<any> {
    const client = this.createClient(channel);
    try {
      const { data } = await client.get('/me', {
        params: { fields: 'id,user_id,username,account_type,name' },
      });
      return data;
    } catch (err: any) {
      throw this.wrapGraphError(err, 'getMe');
    }
  }

  async resolveBusinessId(channel: Channel): Promise<string | null> {
    const cfg = this.getConfig(channel);
    if (cfg.igBusinessId) return cfg.igBusinessId;
    try {
      const info = await this.getMe(channel);
      return info?.user_id ?? info?.id ?? null;
    } catch {
      return null;
    }
  }

  async sendMessage(
    channel: Channel,
    payload: Record<string, any>,
  ): Promise<any> {
    const client = this.createClient(channel);
    try {
      const { data } = await client.post('/me/messages', payload);
      return data;
    } catch (err: any) {
      throw this.wrapGraphError(err, 'sendMessage');
    }
  }

  async listConversations(
    channel: Channel,
    cursor?: string,
    limit = 50,
  ): Promise<{ data: any[]; nextCursor?: string }> {
    const client = this.createClient(channel);
    const params: Record<string, any> = {
      platform: 'instagram',
      fields: 'id,updated_time,participants',
      limit,
    };
    if (cursor) params.after = cursor;

    try {
      const { data } = await client.get('/me/conversations', { params });
      return {
        data: data?.data ?? [],
        nextCursor: data?.paging?.cursors?.after && data?.paging?.next ? data.paging.cursors.after : undefined,
      };
    } catch (err: any) {
      throw this.wrapGraphError(err, 'listConversations');
    }
  }

  async listConversationMessages(
    channel: Channel,
    conversationId: string,
    cursor?: string,
    limit = 50,
  ): Promise<{ data: any[]; nextCursor?: string }> {
    const client = this.createClient(channel);
    const params: Record<string, any> = {
      fields: 'id,created_time,from,to,message,attachments,shares,story,reactions',
      limit,
    };
    if (cursor) params.after = cursor;

    try {
      const { data } = await client.get(`/${conversationId}/messages`, { params });
      return {
        data: data?.data ?? [],
        nextCursor: data?.paging?.cursors?.after && data?.paging?.next ? data.paging.cursors.after : undefined,
      };
    } catch (err: any) {
      throw this.wrapGraphError(err, 'listConversationMessages');
    }
  }

  /**
   * Resolves a contact's profile (username + avatar). Combines:
   *   - `/me/conversations?user_id=...&fields=participants` — reliable for
   *     username/name on graph.instagram.com.
   *   - `GET /{igsid}?fields=name,username,profile_pic` — best-effort for the
   *     avatar. May return `IGApiException code=230 "User consent is required"`
   *     depending on the user — we swallow it and return what we got.
   */
  async getUserProfile(channel: Channel, igUserId: string): Promise<any> {
    const businessId = await this.resolveBusinessId(channel);
    const client = this.createClient(channel);

    let username: string | undefined;
    let name: string | undefined;
    let profile_pic: string | undefined;

    try {
      const { data } = await client.get('/me/conversations', {
        params: {
          user_id: igUserId,
          fields: 'participants',
        },
      });
      const participants: any[] = data?.data?.[0]?.participants?.data || [];
      const contact = participants.find(
        (p) => p?.id && String(p.id) !== String(businessId),
      );
      if (contact) {
        username = contact.username;
        name = contact.name;
      }
    } catch (err: any) {
      this.logger.warn(
        `Instagram getUserProfile via conversations failed for ${igUserId}: ${err.message}`,
      );
    }

    try {
      const { data } = await client.get(`/${igUserId}`, {
        params: { fields: 'name,username,profile_pic' },
      });
      username = username || data?.username;
      name = name || data?.name;
      profile_pic = data?.profile_pic || profile_pic;
    } catch (err: any) {
      // IG frequently refuses this for non-consenting users — don't throw if we
      // already have a username/name.
      const metaCode = err?.response?.data?.error?.code;
      if (!username && !name) {
        if (metaCode === undefined) {
          this.logger.warn(
            `Instagram getUserProfile direct failed for ${igUserId}: ${err.message}`,
          );
        }
      }
    }

    if (!username && !name && !profile_pic) return null;
    return { username, name, profile_pic };
  }

  async getMessageDetail(channel: Channel, messageId: string): Promise<any> {
    const client = this.createClient(channel);
    try {
      const { data } = await client.get(`/${messageId}`, {
        params: { fields: 'id,created_time,from,to,message,attachments,shares,story' },
      });
      return data;
    } catch (err: any) {
      throw this.wrapGraphError(err, 'getMessageDetail');
    }
  }

  async downloadMedia(url: string): Promise<Buffer> {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(response.data);
  }

  /**
   * Tenta deletar/unsend uma DM no Instagram via Graph API.
   * Meta NÃO documenta esse endpoint pra Direct Messages e, na prática,
   * a maioria das apps recebe `(#10) Application does not have permission`
   * ou similar. Mantemos a tentativa pra cobrir o raro caso de tokens
   * com permissões especiais; o adapter captura o erro pra fazer fallback.
   */
  async deleteMessage(
    channel: Channel,
    messageId: string,
  ): Promise<void> {
    const client = this.createClient(channel);
    try {
      await client.delete(`/${messageId}`);
    } catch (err: any) {
      throw this.wrapGraphError(err, 'deleteMessage');
    }
  }

  // ─── Comentários em posts ─────────────────────────────────────────

  async getMedia(
    channel: Channel,
    mediaId: string,
  ): Promise<{
    id: string;
    permalink?: string;
    caption?: string;
    media_type?: string;
    thumbnail_url?: string;
    media_url?: string;
  }> {
    const client = this.createClient(channel);
    try {
      const { data } = await client.get(`/${mediaId}`, {
        params: {
          fields: 'id,permalink,caption,media_type,thumbnail_url,media_url',
        },
      });
      return data;
    } catch (err: any) {
      throw this.wrapGraphError(err, 'getMedia');
    }
  }

  async replyToComment(
    channel: Channel,
    commentId: string,
    message: string,
  ): Promise<{ id: string }> {
    const client = this.createClient(channel);
    try {
      const { data } = await client.post(`/${commentId}/replies`, { message });
      return data;
    } catch (err: any) {
      throw this.wrapGraphError(err, 'replyToComment');
    }
  }

  async deleteComment(channel: Channel, commentId: string): Promise<void> {
    const client = this.createClient(channel);
    try {
      await client.delete(`/${commentId}`);
    } catch (err: any) {
      throw this.wrapGraphError(err, 'deleteComment');
    }
  }

  async setCommentHidden(
    channel: Channel,
    commentId: string,
    hide: boolean,
  ): Promise<void> {
    const client = this.createClient(channel);
    try {
      await client.post(`/${commentId}`, { hide });
    } catch (err: any) {
      throw this.wrapGraphError(err, 'setCommentHidden');
    }
  }

  /**
   * Private Reply: DM iniciada a partir de um comentário. Meta permite uma
   * por comentário, até 7 dias depois dele, fora da regra das 24h.
   */
  async sendPrivateReply(
    channel: Channel,
    commentId: string,
    text: string,
  ): Promise<{ recipient_id?: string; message_id?: string }> {
    return this.sendMessage(channel, {
      recipient: { comment_id: commentId },
      message: { text },
    });
  }

  private wrapGraphError(err: any, context: string): Error {
    const metaError = err?.response?.data?.error;
    if (metaError) {
      const code = metaError.code !== undefined ? `[#${metaError.code}] ` : '';
      const subcode = metaError.error_subcode ? ` (subcode ${metaError.error_subcode})` : '';
      const msg = metaError.message || 'Unknown Meta error';
      this.logger.error(`Instagram ${context} failed: ${code}${msg}${subcode}`);
      return new Error(`Meta Graph API: ${code}${msg}${subcode}`);
    }
    this.logger.error(`Instagram ${context} failed: ${err.message}`);
    return err;
  }
}
