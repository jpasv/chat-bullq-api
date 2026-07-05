import { CanActivate, ExecutionContext, Injectable, HttpException, HttpStatus } from '@nestjs/common';
import * as crypto from 'crypto';
import type { Request } from 'express';

/**
 * Sliding-window in-memory rate limiter para a API pública, keyed pela
 * API-key (hash do header Authorization — nunca guardamos a chave crua).
 * Espelha o WebhookThrottleGuard do channel-hub.
 *
 * In-memory é aceitável em single-instance. Multi-instância: migrar para
 * Redis (ioredis já é dependência) — ver spec §7.
 */
@Injectable()
export class ApiKeyThrottleGuard implements CanActivate {
  private static readonly WINDOW_MS = 5_000;
  private static readonly MAX_HITS = 100;
  private readonly hits = new Map<string, number[]>();
  private lastGc = 0;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const auth = String(req.headers?.authorization || (req.headers as any)?.Authorization || 'anon');
    const key = crypto.createHash('sha256').update(auth).digest('hex');

    const now = Date.now();
    const windowStart = now - ApiKeyThrottleGuard.WINDOW_MS;
    const recent = (this.hits.get(key) || []).filter((t) => t >= windowStart);
    recent.push(now);
    this.hits.set(key, recent);

    if (now - this.lastGc > 30_000) {
      this.lastGc = now;
      for (const [k, arr] of this.hits.entries()) {
        const live = arr.filter((t) => t >= windowStart);
        if (live.length) this.hits.set(k, live);
        else this.hits.delete(k);
      }
    }

    if (recent.length > ApiKeyThrottleGuard.MAX_HITS) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
