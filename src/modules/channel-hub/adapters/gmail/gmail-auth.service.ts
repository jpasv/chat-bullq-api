import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel } from '@prisma/client';
import axios from 'axios';
import { GmailChannelConfig } from './gmail.constants';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  /** refresh_token usado pra emitir — invalida o cache se a config mudar. */
  refreshToken: string;
}

/**
 * Access tokens Gmail POR CANAL (multi-caixa), sem SDK externo — mesmo
 * padrão do GoogleAuthService das client-ops tools, mas o refresh_token
 * vem de `Channel.config` em vez de env: cada canal GMAIL é uma caixa
 * de cliente autorizada individualmente.
 *
 * Env required (OAuth App único pra todas as caixas):
 * - GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
 *   (scopes: gmail.readonly, gmail.send, gmail.modify)
 */
@Injectable()
export class GmailAuthService {
  private readonly logger = new Logger(GmailAuthService.name);
  private readonly cache = new Map<string, CachedToken>();

  constructor(private readonly config: ConfigService) {}

  hasOAuthApp(): boolean {
    return !!(
      this.config.get('GOOGLE_OAUTH_CLIENT_ID') &&
      this.config.get('GOOGLE_OAUTH_CLIENT_SECRET')
    );
  }

  /** Descarta o token em cache (ex.: 401 do Gmail — token revogado). */
  invalidate(channelId: string): void {
    this.cache.delete(channelId);
  }

  async getAccessToken(channel: Channel): Promise<string> {
    const cfg = channel.config as unknown as GmailChannelConfig;
    if (!cfg?.refreshToken) {
      throw new Error(
        `Canal GMAIL ${channel.id} sem refreshToken em config`,
      );
    }

    const cached = this.cache.get(channel.id);
    if (
      cached &&
      cached.refreshToken === cfg.refreshToken &&
      Date.now() < cached.expiresAt
    ) {
      return cached.accessToken;
    }

    const resp = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID') ?? '',
        client_secret:
          this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET') ?? '',
        refresh_token: cfg.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10_000,
      },
    );

    const token: string = resp.data.access_token;
    const expiresIn: number = resp.data.expires_in ?? 3600;
    this.cache.set(channel.id, {
      accessToken: token,
      expiresAt: Date.now() + (expiresIn - 60) * 1000,
      refreshToken: cfg.refreshToken,
    });
    return token;
  }
}
