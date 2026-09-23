import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Atomic idempotency + distributed locks, backed by Redis.
 *
 * `claimProcessing` uses SET NX EX so two concurrent workers cannot both
 * believe they are the first to process a given externalMessageId.
 *
 * `acquireLock` / `releaseLock` implement a per-key mutex for serialising
 * contact/conversation upserts to avoid duplicate rows when a burst of
 * messages from the same new contact arrives.
 */
@Injectable()
export class IdempotencyService implements OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly redis: Redis;
  private static readonly TTL_SECONDS = 24 * 60 * 60; // 24h
  private static readonly LOCK_TTL_MS = 10_000;

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
      password: this.config.get<string>('REDIS_PASSWORD') || undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      /* noop */
    }
  }

  private key(channelId: string, externalMessageId: string): string {
    return `idemp:${channelId}:${externalMessageId}`;
  }

  /**
   * Atomic claim. Returns true when THIS caller won the race (and therefore
   * must process the message). Returns false when the message was already
   * claimed — caller MUST skip.
   */
  async claimProcessing(
    externalMessageId: string,
    channelId: string,
  ): Promise<boolean> {
    if (!externalMessageId) return true;
    const res = await this.redis.set(
      this.key(channelId, externalMessageId),
      '1',
      'EX',
      IdempotencyService.TTL_SECONDS,
      'NX',
    );
    return res === 'OK';
  }

  /** Release a failed processing claim so the next attempt can retry. */
  async releaseClaim(
    externalMessageId: string,
    channelId: string,
  ): Promise<void> {
    if (!externalMessageId) return;
    await this.redis.del(this.key(channelId, externalMessageId));
  }

  /** Post-hoc mark — only used when we SKIP the processing path but
   *  still want to short-circuit later duplicate webhooks (e.g. an outbound
   *  that was already persisted by MessagesService). */
  async markProcessed(
    externalMessageId: string,
    channelId: string,
  ): Promise<void> {
    if (!externalMessageId) return;
    await this.redis.set(
      this.key(channelId, externalMessageId),
      '1',
      'EX',
      IdempotencyService.TTL_SECONDS,
    );
  }

  async isDuplicate(
    externalMessageId: string,
    channelId: string,
  ): Promise<boolean> {
    if (!externalMessageId) return false;
    return (await this.redis.exists(this.key(channelId, externalMessageId))) === 1;
  }

  /**
   * Cooperative lock for serialising upserts. Returns a release token when
   * the lock was acquired, null otherwise. Caller retries with small jitter.
   */
  async acquireLock(lockKey: string, ttlMs = IdempotencyService.LOCK_TTL_MS): Promise<string | null> {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const res = await this.redis.set(
      `lock:${lockKey}`,
      token,
      'PX',
      ttlMs,
      'NX',
    );
    return res === 'OK' ? token : null;
  }

  async releaseLock(lockKey: string, token: string): Promise<void> {
    // Lua script: delete only if value matches (prevents releasing someone else's lock)
    const script = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
    `;
    try {
      await this.redis.eval(script, 1, `lock:${lockKey}`, token);
    } catch (err: any) {
      this.logger.warn(`releaseLock failed for ${lockKey}: ${err.message}`);
    }
  }

  async withLock<T>(
    lockKey: string,
    fn: () => Promise<T>,
    opts: { ttlMs?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const ttlMs = opts.ttlMs ?? IdempotencyService.LOCK_TTL_MS;
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const start = Date.now();
    while (true) {
      const token = await this.acquireLock(lockKey, ttlMs);
      if (token) {
        try {
          return await fn();
        } finally {
          await this.releaseLock(lockKey, token);
        }
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`Timed out acquiring lock ${lockKey}`);
      }
      await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 50)));
    }
  }
}
