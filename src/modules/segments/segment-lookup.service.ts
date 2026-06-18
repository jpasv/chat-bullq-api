import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Roteamento de um canal que é membro de um Segmento ativo.
 *
 * - `primaryChannelId`: canal por onde as conversas de grupo são ancoradas
 *   (envio, RBAC, realtime). A conversa de grupo recebe channelId = principal.
 * - `ownNumbers`: telefones próprios (dígitos) de TODOS os membros do segmento.
 *   Usado para classificar direção: se o remetente de uma mensagem de grupo é
 *   um número nosso, a mensagem é OUTBOUND (mesmo chegando como fromMe=false
 *   pela cópia de outro membro).
 */
export interface SegmentRouting {
  segmentId: string;
  primaryChannelId: string;
  ownNumbers: Set<string>;
}

/** Normaliza um telefone/JID para apenas dígitos (ex.: "55 11 9..."→"5511..."). */
export function normalizePhone(value: unknown): string {
  if (value == null) return '';
  return String(value).replace(/\D/g, '');
}

/** Extrai o número da instância a partir do campo `owner` do payload Zappfy. */
export function extractOwnerNumber(ownerRaw: unknown): string {
  if (ownerRaw == null) return '';
  if (typeof ownerRaw === 'object') {
    const obj = ownerRaw as Record<string, any>;
    return normalizePhone(obj.id ?? obj.user ?? obj.number ?? '');
  }
  return normalizePhone(ownerRaw);
}

interface CacheEntry {
  routing: SegmentRouting | null;
  expiresAt: number;
}

@Injectable()
export class SegmentLookupService {
  private readonly logger = new Logger(SegmentLookupService.name);

  /** Cache curto por canal — `forChannel` roda em TODA mensagem inbound. */
  private readonly cache = new Map<string, CacheEntry>();
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(private readonly prisma: PrismaService) {}

  /** Invalida o cache (chamar após mudanças de segmento/membros/principal). */
  invalidate(): void {
    this.cache.clear();
  }

  /**
   * Retorna o roteamento se `channelId` é membro de um Segmento ativo COM
   * canal principal definido. Caso contrário, null (caminho normal por canal).
   */
  async forChannel(channelId: string): Promise<SegmentRouting | null> {
    const cached = this.cache.get(channelId);
    if (cached && cached.expiresAt > Date.now()) return cached.routing;

    const membership = await this.prisma.segmentChannel.findFirst({
      where: {
        channelId,
        segment: { isActive: true, deletedAt: null },
      },
      select: {
        segment: {
          select: {
            id: true,
            primaryChannelId: true,
            members: {
              select: { channel: { select: { config: true } } },
            },
          },
        },
      },
    });

    let routing: SegmentRouting | null = null;
    const segment = membership?.segment;
    if (segment && segment.primaryChannelId) {
      const ownNumbers = new Set<string>();
      for (const m of segment.members) {
        const cfg = (m.channel?.config ?? {}) as Record<string, any>;
        const num = normalizePhone(cfg.ownPhone);
        if (num) ownNumbers.add(num);
      }
      routing = {
        segmentId: segment.id,
        primaryChannelId: segment.primaryChannelId,
        ownNumbers,
      };
    }

    this.cache.set(channelId, {
      routing,
      expiresAt: Date.now() + SegmentLookupService.CACHE_TTL_MS,
    });
    return routing;
  }

  /**
   * Persiste o número próprio do canal em `config.ownPhone` se ainda não
   * estiver setado ou tiver mudado. Idempotente e barato (só escreve no diff).
   */
  async captureOwnNumber(channelId: string, ownerRaw: unknown): Promise<void> {
    const number = extractOwnerNumber(ownerRaw);
    if (!number) return;
    try {
      const channel = await this.prisma.channel.findUnique({
        where: { id: channelId },
        select: { config: true },
      });
      if (!channel) return;
      const config = (channel.config ?? {}) as Record<string, any>;
      if (normalizePhone(config.ownPhone) === number) return;
      await this.prisma.channel.update({
        where: { id: channelId },
        data: { config: { ...config, ownPhone: number } },
      });
      this.invalidate();
      this.logger.log(`Captured own number for channel ${channelId}: ${number}`);
    } catch (err: any) {
      this.logger.warn(
        `captureOwnNumber failed for ${channelId}: ${err?.message ?? err}`,
      );
    }
  }
}
