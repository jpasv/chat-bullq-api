import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface HoppeLeadTask {
  id: string;
  name: string;
  statusName: string | null;
  tags: string[];
  /** Custom fields indexados pelo nome (como aparecem na UI do Hoppe). */
  fields: Record<string, unknown>;
}

/**
 * Escrita/leitura das tasks da list Leads onboarding na API pública do Hoppe
 * (v2). Erros de rede sobem — quem chama decide se tenta de novo ou só loga.
 *
 * Env: HOPPE_API_KEY (HOPPE_BASE_URL opcional), as mesmas da Sofia.
 */
@Injectable()
export class HoppeLeadsClient {
  private readonly logger = new Logger(HoppeLeadsClient.name);

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('HOPPE_BASE_URL') ?? 'https://hoppe-api.bravy.com.br';
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const apiKey = this.config.get<string>('HOPPE_API_KEY');
    if (!apiKey) throw new Error('HOPPE_API_KEY não configurada');
    const resp = await axios.request<T>({
      method,
      url: `${this.baseUrl}${path}`,
      data: body,
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      timeout: 15_000,
    });
    return resp.data;
  }

  async getTask(taskId: string): Promise<HoppeLeadTask | null> {
    try {
      const data = await this.request<any>('GET', `/api/v2/task/${taskId}`);
      const t = data?.task ?? data;
      if (!t?.id) return null;
      const fields: Record<string, unknown> = {};
      for (const cf of t.custom_fields ?? []) {
        if (cf?.name) fields[cf.name] = cf.value ?? null;
      }
      return {
        id: t.id,
        name: t.name ?? '',
        statusName: t.status?.status ?? null,
        tags: (t.tags ?? []).map((tag: any) => tag?.name).filter(Boolean),
        fields,
      };
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }

  async setStatus(taskId: string, statusId: string): Promise<void> {
    await this.request('PUT', `/api/v2/task/${taskId}`, { status: statusId });
  }

  /** Dropdown aceita o nome da opção como valor. */
  async setField(taskId: string, fieldId: string, value: unknown): Promise<void> {
    await this.request('POST', `/api/v2/task/${taskId}/field/${fieldId}`, { value });
  }

  async addTag(taskId: string, tagName: string): Promise<void> {
    await this.request(
      'POST',
      `/api/v2/task/${taskId}/tag/${encodeURIComponent(tagName)}`,
    );
  }

  async addComment(taskId: string, text: string): Promise<void> {
    await this.request('POST', `/api/v2/task/${taskId}/comment`, {
      comment_text: text,
    });
  }
}
