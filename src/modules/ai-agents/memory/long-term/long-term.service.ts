import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../../database/prisma.service';
import { AgentMemoryRecord, MemoryFact } from './long-term.types';

/**
 * Long-term memory service — CRUD over the `ai_agent_memories` table.
 *
 * One row per (agentId, contactId). The `facts` JSON column stores an array
 * of `MemoryFact` (we deserialize on read, serialize on write). All callers
 * — the Fugu extractor, the operator UI, the context enrichment service —
 * go through this service so the JSON shape stays consistent.
 */
@Injectable()
export class LongTermMemoryService {
  private readonly logger = new Logger(LongTermMemoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the memory row for (agentId, contactId), creating an empty one
   * if none exists yet. Always returns a typed `AgentMemoryRecord` so the
   * caller never has to think about the raw JSON column.
   */
  async getOrCreate(
    agentId: string,
    contactId: string,
  ): Promise<AgentMemoryRecord> {
    let row = await this.prisma.aiAgentMemory.findUnique({
      where: { agentId_contactId: { agentId, contactId } },
    });
    if (!row) {
      row = await this.prisma.aiAgentMemory.create({
        data: {
          agentId,
          contactId,
          // The schema default is `{}` (object). We use `[]` consistently
          // so the deserializer always sees an array.
          facts: [] as unknown as object,
          totalInteractions: 0,
        },
      });
    }
    return this.toRecord(row);
  }

  /** Read-only fetch — returns `null` if the row doesn't exist. */
  async findOne(
    agentId: string,
    contactId: string,
  ): Promise<AgentMemoryRecord | null> {
    const row = await this.prisma.aiAgentMemory.findUnique({
      where: { agentId_contactId: { agentId, contactId } },
    });
    return row ? this.toRecord(row) : null;
  }

  /**
   * Merges new facts into the existing list and removes any facts whose
   * `fact` text matches `factsToRemove`. Updates `lastInteractionAt`.
   *
   * Idempotent on the new-fact side: if a fact text already exists, it is
   * not duplicated.
   */
  async upsertFacts(
    agentId: string,
    contactId: string,
    newFacts: MemoryFact[],
    factsToRemove: string[],
  ): Promise<void> {
    const current = await this.getOrCreate(agentId, contactId);
    const removeSet = new Set(factsToRemove);
    const filtered = current.facts.filter((f) => !removeSet.has(f.fact));

    const existingTexts = new Set(filtered.map((f) => f.fact));
    const deduped = newFacts.filter((f) => !existingTexts.has(f.fact));

    const merged: MemoryFact[] = [...filtered, ...deduped];

    await this.prisma.aiAgentMemory.update({
      where: { agentId_contactId: { agentId, contactId } },
      data: {
        facts: merged as unknown as object,
        lastInteractionAt: new Date(),
      },
    });

    this.logger.log(
      `memory_facts_updated agent=${agentId} contact=${contactId} added=${deduped.length} removed=${factsToRemove.length} total=${merged.length}`,
    );
  }

  /**
   * Updates the human-readable `summary` paragraph. Increments
   * `totalInteractions` so we have a counter of how many times the auto-
   * extractor ran for this pair.
   */
  async updateSummary(
    agentId: string,
    contactId: string,
    summary: string,
  ): Promise<void> {
    // Make sure the row exists so the update doesn't fail.
    await this.getOrCreate(agentId, contactId);
    await this.prisma.aiAgentMemory.update({
      where: { agentId_contactId: { agentId, contactId } },
      data: {
        summary,
        totalInteractions: { increment: 1 },
        lastInteractionAt: new Date(),
      },
    });
  }

  /**
   * Hard reset — wipes summary + facts. Used by the operator UI when a
   * memory got polluted and needs to start over.
   */
  async clear(agentId: string, contactId: string): Promise<void> {
    await this.prisma.aiAgentMemory.upsert({
      where: { agentId_contactId: { agentId, contactId } },
      create: {
        agentId,
        contactId,
        facts: [] as unknown as object,
        summary: null,
      },
      update: {
        facts: [] as unknown as object,
        summary: null,
      },
    });
  }

  // ─── internal helpers ───────────────────────────────────────────────

  private toRecord(row: {
    id: string;
    agentId: string;
    contactId: string;
    summary: string | null;
    facts: unknown;
    totalInteractions: number;
    lastInteractionAt: Date | null;
  }): AgentMemoryRecord {
    return {
      id: row.id,
      agentId: row.agentId,
      contactId: row.contactId,
      summary: row.summary,
      facts: this.parseFacts(row.facts),
      totalInteractions: row.totalInteractions,
      lastInteractionAt: row.lastInteractionAt,
    };
  }

  /**
   * Tolerant parser — the JSON column historically defaulted to `{}` and
   * could have been touched manually. Anything that isn't a clean array
   * of valid `MemoryFact` shapes is silently ignored, never thrown.
   */
  private parseFacts(raw: unknown): MemoryFact[] {
    if (!Array.isArray(raw)) return [];
    const out: MemoryFact[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      if (typeof r.fact !== 'string') continue;
      out.push({
        fact: r.fact,
        category: typeof r.category === 'string' ? r.category : undefined,
        confidence:
          typeof r.confidence === 'number' ? r.confidence : undefined,
        extractedAt:
          typeof r.extractedAt === 'string'
            ? r.extractedAt
            : new Date().toISOString(),
        source: r.source === 'auto' ? 'auto' : 'manual',
      });
    }
    return out;
  }
}
