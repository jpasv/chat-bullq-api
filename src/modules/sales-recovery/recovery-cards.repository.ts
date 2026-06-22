import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Card } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RecoveryConfigService } from './recovery-config.service';

export type RecoveryStageKey =
  | 'opportunity'
  | 'contact_attempt'
  | 'in_contact'
  | 'follow_up'
  | 'lost'
  | 'won'
  | 'refunded';

interface ResolvedPipeline {
  pipelineId: string;
  stageIdByKey: Map<string, string>;
  fetchedAt: number;
}

/**
 * Acesso Prisma do pipeline de recuperação. Resolve o pipeline/stages pela
 * `key` (estável, ≠ nome editável) e acha cards abertos por contato ou pelo
 * checkout da Kirvano (guardado em card.metadata.kirvano.checkoutId).
 */
@Injectable()
export class RecoveryCardsRepository {
  private readonly logger = new Logger(RecoveryCardsRepository.name);
  // Cache leve por org — stages quase nunca mudam. TTL curto cobre re-seed.
  private readonly cache = new Map<string, ResolvedPipeline>();
  private readonly ttlMs = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: RecoveryConfigService,
  ) {}

  async getPipelineId(organizationId: string): Promise<string> {
    return (await this.resolve(organizationId)).pipelineId;
  }

  async resolveStageId(
    organizationId: string,
    stageKey: RecoveryStageKey,
  ): Promise<string> {
    let resolved = await this.resolve(organizationId);
    let stageId = resolved.stageIdByKey.get(stageKey);
    if (!stageId) {
      // Pode ter sido criado depois do cache — força refresh uma vez.
      resolved = await this.resolve(organizationId, true);
      stageId = resolved.stageIdByKey.get(stageKey);
    }
    if (!stageId) {
      throw new NotFoundException(
        `Stage "${stageKey}" não encontrado no pipeline de recuperação da org ${organizationId}. Rode o seed.`,
      );
    }
    return stageId;
  }

  async findOpenCardByContact(
    organizationId: string,
    contactId: string,
  ): Promise<Card | null> {
    const pipelineId = await this.getPipelineId(organizationId);
    return this.prisma.card.findFirst({
      where: { organizationId, pipelineId, contactId, status: 'OPEN' },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findCardByCheckout(
    organizationId: string,
    checkoutId: string,
  ): Promise<Card | null> {
    const pipelineId = await this.getPipelineId(organizationId);
    return this.prisma.card.findFirst({
      where: {
        organizationId,
        pipelineId,
        metadata: {
          path: ['kirvano', 'checkoutId'],
          equals: checkoutId,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /** Posição (toIndex) pra inserir no fim de uma coluna. */
  async nextIndexInStage(pipelineId: string, stageId: string): Promise<number> {
    const last = await this.prisma.card.findFirst({
      where: { pipelineId, stageId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    return (last?.order ?? -1) + 1;
  }

  /** Cards abertos parados nas stages "vivas" há mais que `cutoff`. */
  async findStuckCards(
    organizationId: string,
    stageIds: string[],
    cutoff: Date,
    take = 500,
  ): Promise<Card[]> {
    const pipelineId = await this.getPipelineId(organizationId);
    return this.prisma.card.findMany({
      where: {
        organizationId,
        pipelineId,
        status: 'OPEN',
        stageId: { in: stageIds },
        updatedAt: { lt: cutoff },
      },
      orderBy: { updatedAt: 'asc' },
      take,
    });
  }

  invalidate(organizationId: string): void {
    this.cache.delete(organizationId);
  }

  private async resolve(
    organizationId: string,
    force = false,
  ): Promise<ResolvedPipeline> {
    const cached = this.cache.get(organizationId);
    if (!force && cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached;
    }

    const pipeline = await this.prisma.pipeline.findFirst({
      where: { organizationId, key: this.config.pipelineKey },
      include: { stages: true },
    });
    if (!pipeline) {
      throw new NotFoundException(
        `Pipeline de recuperação (key=${this.config.pipelineKey}) não existe na org ${organizationId}. Rode o seed.`,
      );
    }

    const stageIdByKey = new Map<string, string>();
    for (const s of pipeline.stages) {
      if (s.key) stageIdByKey.set(s.key, s.id);
    }

    const resolved: ResolvedPipeline = {
      pipelineId: pipeline.id,
      stageIdByKey,
      fetchedAt: Date.now(),
    };
    this.cache.set(organizationId, resolved);
    return resolved;
  }
}
