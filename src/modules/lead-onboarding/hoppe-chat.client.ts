import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/**
 * Posta mensagens nos canais do chat do Hoppe. A API pública (v2) não posta
 * em canal, então usa a API interna (v1) com JWT de login de um usuário.
 *
 * Env: HOPPE_LOGIN_EMAIL, HOPPE_LOGIN_PASSWORD, HOPPE_WORKSPACE_ID
 * (HOPPE_BASE_URL opcional). As mensagens saem no nome desse usuário.
 */
@Injectable()
export class HoppeChatClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('HOPPE_BASE_URL') ?? 'https://hoppe-api.bravy.com.br';
  }

  private get workspaceId(): string {
    return (
      this.config.get<string>('HOPPE_WORKSPACE_ID') ?? 'abec42cf-cf2a-45f6-9a04-33c04c8605da'
    );
  }

  get configured(): boolean {
    return Boolean(
      this.config.get<string>('HOPPE_LOGIN_EMAIL') && this.config.get<string>('HOPPE_LOGIN_PASSWORD'),
    );
  }

  async postToChannel(channelId: string, html: string): Promise<void> {
    const token = await this.accessToken();
    await axios.post(
      `${this.baseUrl}/api/v1/chat/channels/${channelId}/messages`,
      { content: html },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'x-workspace-id': this.workspaceId,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      },
    );
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_MARGIN_MS > Date.now()) return this.token.value;
    const email = this.config.get<string>('HOPPE_LOGIN_EMAIL');
    const password = this.config.get<string>('HOPPE_LOGIN_PASSWORD');
    if (!email || !password) throw new Error('HOPPE_LOGIN_EMAIL/HOPPE_LOGIN_PASSWORD não configuradas');
    const resp = await axios.post<{ access_token: string }>(
      `${this.baseUrl}/api/v1/auth/login`,
      { email, password },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 },
    );
    const value = resp.data.access_token;
    this.token = { value, expiresAt: jwtExpiry(value) };
    return value;
  }
}

/** `exp` do JWT em ms; sem `exp` legível, assume 1h. */
export function jwtExpiry(token: string, now = Date.now()): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    // cai no default
  }
  return now + 60 * 60 * 1000;
}
