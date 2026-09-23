import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import * as crypto from 'crypto';
import {
  InboundChannelPort,
  ChannelLocator,
} from '../../ports/inbound-channel.port';
import {
  WebhookParseResult,
  VerificationResponse,
} from '../../ports/types';
import { ZappfyMessageMapper } from './zappfy.message-mapper';

@Injectable()
export class ZappfyInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_ZAPPFY;
  private readonly logger = new Logger(ZappfyInboundAdapter.name);

  constructor(private readonly mapper: ZappfyMessageMapper) {}

  extractLocators(
    payload: unknown,
    headers: Record<string, string>,
  ): ChannelLocator[] {
    const event = (payload ?? {}) as Record<string, any>;
    // Uazapi / Zappfy ship identifiers in multiple places depending on firmware.
    // Check header first (fast path), then common body locations.
    const instanceId: string | undefined =
      event?.instance?.id ||
      event?.instanceId ||
      event?.instance_id ||
      event?.owner?.id ||
      event?.owner ||
      event?.sender ||
      undefined;
    const token =
      headers['x-webhook-token'] ||
      headers['token'] ||
      event?.token ||
      event?.instance?.token ||
      event?.instanceToken ||
      undefined;
    const locator: ChannelLocator = {};
    if (instanceId) locator.instanceId = String(instanceId);
    if (token) locator.token = String(token);
    // Even when we can't extract anything, return one empty locator — the
    // resolver will fall back to single-channel heuristics below.
    return [locator];
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    const config = (channel.config ?? {}) as Record<string, any>;

    // 1. Strong match by instance id — preferred whenever present.
    if (locator.instanceId && config.instanceId) {
      return String(config.instanceId) === locator.instanceId;
    }

    // 2. Match by provider API token (stored in config.token, uniquely
    //    identifies an instance on Uazapi/Zappfy).
    if (locator.token && config.token) {
      return this.timingSafeEqualStr(
        String(config.token),
        String(locator.token),
      );
    }

    // 3. Match by channel-level webhookSecret if caller explicitly set one.
    if (channel.webhookSecret && locator.token) {
      return this.timingSafeEqualStr(
        channel.webhookSecret,
        String(locator.token),
      );
    }

    // 4. Dev/legacy fallback: when the payload has no routing hint at all
    //    AND the channel has no identifying fields either, we can't
    //    distinguish multiple instances — but the common case is a single
    //    Zappfy channel per org. Returning false forces the operator to
    //    configure `config.token` (which we always have) via the proper
    //    path. Keep false here to avoid cross-tenant leaks.
    return false;
  }

  validateWebhook(
    headers: Record<string, string>,
    _rawBody: Buffer,
    webhookSecret?: string,
    channel?: Channel,
  ): boolean {
    // Routing by instanceId does not authenticate the sender.
    const channelToken = (channel?.config as Record<string, unknown> | undefined)?.token;
    const secrets = [webhookSecret, channel?.webhookSecret, channelToken]
      .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
    if (secrets.length === 0) {
      this.logger.warn('Zappfy webhook rejected: token/webhookSecret is not configured');
      return false;
    }
    const headerToken = headers['x-webhook-token'] || headers['token'];
    const candidate = headerToken || this.extractBodyToken(_rawBody);
    if (typeof candidate !== 'string' || !candidate) return false;
    return secrets.some((secret) => this.timingSafeEqualStr(secret, candidate));
  }

  private extractBodyToken(rawBody: Buffer): string | undefined {
    try {
      const json = JSON.parse(rawBody.toString('utf8')) as Record<string, any>;
      return json?.token || json?.instance?.token || json?.instanceToken || undefined;
    } catch {
      return undefined;
    }
  }

  private timingSafeEqualStr(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    try {
      return crypto.timingSafeEqual(ba, bb);
    } catch {
      return false;
    }
  }

  parseWebhook(payload: unknown, _channel?: Channel): WebhookParseResult {
    const result: WebhookParseResult = {
      messages: [],
      statuses: [],
      errors: [],
    };

    try {
      const event = payload as any;
      const eventType = event?.EventType || event?.event;

      if (eventType === 'messages' || eventType === 'messages.upsert') {
        const normalized = this.mapper.normalizeInbound(event);
        if (normalized) {
          result.messages.push(normalized);
        }
      } else if (eventType === 'messages_update' || eventType === 'messages.update') {
        const status = this.mapper.normalizeStatus(event);
        if (status) {
          result.statuses.push(status);
        }
      }
    } catch (error: any) {
      this.logger.error(`Failed to parse Zappfy webhook: ${error.message}`);
      result.errors.push({
        code: 'PARSE_ERROR',
        message: error.message,
        rawData: payload,
      });
    }

    return result;
  }

  handleVerification(
    _query: Record<string, string>,
    _webhookSecret?: string,
  ): VerificationResponse {
    return { statusCode: 200, body: 'OK' };
  }
}
