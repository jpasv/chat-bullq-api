import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosRequestConfig } from 'axios';
import { GmailAuthService } from './gmail-auth.service';

/** Shapes mínimos da Gmail API que consumimos (REST v1). */
export interface GmailProfile {
  emailAddress: string;
  historyId: string;
  messagesTotal?: number;
}

export interface GmailMessageStub {
  id: string;
  threadId: string;
  labelIds?: string[];
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessage extends GmailMessageStub {
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: GmailMessageStub }>;
}

export interface GmailHistoryPage {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  /** historyId corrente da caixa — novo watermark após drenar as páginas. */
  historyId?: string;
}

export interface GmailListPage {
  messages?: GmailMessageStub[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

const MAX_RETRIES = 3;

/**
 * Cliente HTTP da Gmail API (REST v1) — axios puro, sem SDK, seguindo o
 * padrão dos outros http-clients de adapter. Auth Bearer por canal via
 * GmailAuthService; retry com backoff exponencial truncado em 429/5xx
 * (recomendação oficial da doc de quota).
 */
@Injectable()
export class GmailHttpClient {
  private static readonly BASE_URL =
    'https://gmail.googleapis.com/gmail/v1/users/me';
  private readonly logger = new Logger(GmailHttpClient.name);

  constructor(private readonly auth: GmailAuthService) {}

  async getProfile(channel: Channel): Promise<GmailProfile> {
    return this.request(channel, { method: 'GET', url: '/profile' });
  }

  /**
   * Uma página do sync incremental. Lança o AxiosError original em 404
   * (startHistoryId expirado) — o poller detecta e cai pro full sync.
   */
  async listHistory(
    channel: Channel,
    startHistoryId: string,
    pageToken?: string,
  ): Promise<GmailHistoryPage> {
    return this.request(channel, {
      method: 'GET',
      url: '/history',
      params: {
        startHistoryId,
        historyTypes: 'messageAdded',
        maxResults: 100,
        ...(pageToken ? { pageToken } : {}),
      },
    });
  }

  /** Busca por query (q usa a sintaxe de busca do Gmail, ex. `after:<epoch>`). */
  async listMessages(
    channel: Channel,
    q: string,
    maxResults = 100,
    pageToken?: string,
  ): Promise<GmailListPage> {
    return this.request(channel, {
      method: 'GET',
      url: '/messages',
      params: { q, maxResults, ...(pageToken ? { pageToken } : {}) },
    });
  }

  async getMessage(
    channel: Channel,
    id: string,
    format: 'full' | 'metadata' | 'minimal' = 'full',
  ): Promise<GmailMessage> {
    return this.request(channel, {
      method: 'GET',
      url: `/messages/${id}`,
      params: { format },
    });
  }

  /** Envia um MIME RFC 2822 já em base64url; threadId agrupa como reply. */
  async sendMessage(
    channel: Channel,
    raw: string,
    threadId?: string,
  ): Promise<GmailMessageStub> {
    return this.request(channel, {
      method: 'POST',
      url: '/messages/send',
      data: { raw, ...(threadId ? { threadId } : {}) },
    });
  }

  /** Cria rascunho (modo revisão humana) — não envia. */
  async createDraft(
    channel: Channel,
    raw: string,
    threadId?: string,
  ): Promise<{ id: string; message?: GmailMessageStub }> {
    return this.request(channel, {
      method: 'POST',
      url: '/drafts',
      data: { message: { raw, ...(threadId ? { threadId } : {}) } },
    });
  }

  /** Read/unread, arquivar etc. são labels no Gmail. */
  async modifyLabels(
    channel: Channel,
    messageId: string,
    opts: { add?: string[]; remove?: string[] },
  ): Promise<GmailMessageStub> {
    return this.request(channel, {
      method: 'POST',
      url: `/messages/${messageId}/modify`,
      data: {
        ...(opts.add?.length ? { addLabelIds: opts.add } : {}),
        ...(opts.remove?.length ? { removeLabelIds: opts.remove } : {}),
      },
    });
  }

  /** Move pra lixeira NA CAIXA do canal (email não tem "apagar pra todos"). */
  async trashMessage(channel: Channel, messageId: string): Promise<void> {
    await this.request(channel, {
      method: 'POST',
      url: `/messages/${messageId}/trash`,
    });
  }

  /** Baixa bytes de um anexo (base64url → Buffer). */
  async getAttachment(
    channel: Channel,
    messageId: string,
    attachmentId: string,
  ): Promise<Buffer> {
    const resp = await this.request<{ data?: string }>(channel, {
      method: 'GET',
      url: `/messages/${messageId}/attachments/${attachmentId}`,
    });
    if (!resp?.data) {
      throw new Error(
        `Gmail attachments.get sem data (msg=${messageId} att=${attachmentId})`,
      );
    }
    return Buffer.from(resp.data, 'base64url');
  }

  private async request<T = any>(
    channel: Channel,
    cfg: AxiosRequestConfig,
    attempt = 0,
  ): Promise<T> {
    const token = await this.auth.getAccessToken(channel);
    try {
      const response = await axios.request<T>({
        baseURL: GmailHttpClient.BASE_URL,
        timeout: 30_000,
        ...cfg,
        headers: { Authorization: `Bearer ${token}`, ...(cfg.headers ?? {}) },
      });
      return response.data;
    } catch (error: any) {
      const status: number | undefined = error?.response?.status;

      // Access token revogado/expirado fora da janela do cache — invalida
      // e tenta UMA vez com token fresco.
      if (status === 401 && attempt === 0) {
        this.auth.invalidate(channel.id);
        return this.request(channel, cfg, attempt + 1);
      }

      // Backoff exponencial truncado (doc oficial): 429/5xx são transientes.
      if (
        (status === 429 || (status !== undefined && status >= 500)) &&
        attempt < MAX_RETRIES
      ) {
        const delay = Math.min(
          2 ** attempt * 1000 + Math.floor(Math.random() * 500),
          8_000,
        );
        await new Promise((r) => setTimeout(r, delay));
        return this.request(channel, cfg, attempt + 1);
      }

      this.logger.error(
        `Gmail API error: ${cfg.method} ${cfg.url} → ${status ?? '?'} - ${
          error?.response?.data?.error?.message || error.message
        }`,
      );
      throw error;
    }
  }
}
