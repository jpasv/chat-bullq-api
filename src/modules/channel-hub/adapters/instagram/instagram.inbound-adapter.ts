import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel, ChannelType } from '@prisma/client';
import * as crypto from 'crypto';
import {
  InboundChannelPort,
  ChannelLocator,
} from '../../ports/inbound-channel.port';
import { WebhookParseResult, VerificationResponse } from '../../ports/types';
import { InstagramMessageMapper } from './instagram.message-mapper';

@Injectable()
export class InstagramInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.INSTAGRAM;
  private readonly logger = new Logger(InstagramInboundAdapter.name);

  constructor(
    private readonly mapper: InstagramMessageMapper,
    private readonly configService: ConfigService,
  ) {}

  extractLocators(payload: unknown): ChannelLocator[] {
    const body = (payload ?? {}) as Record<string, any>;
    const entries: any[] = body?.entry || [];
    const seen = new Set<string>();
    const locators: ChannelLocator[] = [];
    for (const entry of entries) {
      const id = entry?.id ? String(entry.id) : undefined;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      locators.push({ igBusinessId: id });
    }
    return locators;
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    const config = (channel.config ?? {}) as Record<string, any>;
    const candidates = [
      config.igBusinessId,
      config.igUserId,
      config.pageId,
    ].filter(Boolean) as string[];
    if (!locator.igBusinessId || candidates.length === 0) return false;
    return candidates.some((c) => String(c) === locator.igBusinessId);
  }

  validateWebhook(
    headers: Record<string, string>,
    rawBody: Buffer,
    _webhookSecret?: string,
    channel?: Channel,
  ): boolean {
    const appSecret = (channel?.config as Record<string, any> | undefined)?.appSecret;
    if (!appSecret) {
      const requireAuth = String(this.configService.get('WEBHOOK_REQUIRE_AUTH', false)) === 'true';
      this.logger.warn(
        `Instagram webhook ${requireAuth ? 'rejected' : 'accepted WITHOUT authentication'}: channelId=${channel?.id ?? 'unknown'}; configure appSecret (WEBHOOK_REQUIRE_AUTH=${requireAuth})`,
      );
      return !requireAuth;
    }

    const signature = headers['x-hub-signature-256'];
    if (!signature) return false;

    const expected = 'sha256=' +
      crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected),
      );
    } catch {
      return false;
    }
  }

  parseWebhook(payload: unknown, channel?: Channel): WebhookParseResult {
    const result: WebhookParseResult = {
      messages: [],
      statuses: [],
      errors: [],
      comments: [],
    };

    try {
      const body = payload as Record<string, any>;
      const entries = body?.entry || [];
      const cfg = (channel?.config as any) || {};
      const expectedId = cfg.igBusinessId
        ? String(cfg.igBusinessId)
        : cfg.igUserId
          ? String(cfg.igUserId)
          : undefined;

      for (const entry of entries) {
        // Strict scoping: drop entries for a different IG business account
        if (
          expectedId &&
          entry?.id &&
          String(entry.id) !== expectedId
        ) {
          continue;
        }
        const messagingEvents = entry?.messaging || [];
        for (const event of messagingEvents) {
          if (event.message) {
            const normalized = this.mapper.normalizeInbound(event);
            if (normalized) {
              result.messages.push(normalized);
            }
          }
          if (event.delivery) {
            const status = this.mapper.normalizeStatus(event);
            if (status) {
              result.statuses.push(status);
            }
          }
          if (event.read) {
            const status = this.mapper.normalizeReadStatus(event);
            if (status) {
              result.statuses.push(status);
            }
          }
        }

        const changes: any[] = entry?.changes || [];
        for (const change of changes) {
          if (change?.field !== 'comments') continue;
          const normalized = this.mapper.normalizeComment(
            change.value ?? {},
            typeof entry?.time === 'number' ? entry.time : undefined,
          );
          if (normalized) {
            result.comments!.push(normalized);
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Failed to parse Instagram webhook: ${error.message}`);
      result.errors.push({
        code: 'PARSE_ERROR',
        message: error.message,
        rawData: payload,
      });
    }

    return result;
  }

  handleVerification(
    query: Record<string, string>,
    webhookSecret?: string,
  ): VerificationResponse {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === webhookSecret) {
      this.logger.log('Instagram webhook verification successful');
      return { statusCode: 200, body: challenge };
    }

    this.logger.warn('Instagram webhook verification failed');
    return { statusCode: 403, body: { error: 'Verification failed' } };
  }
}
