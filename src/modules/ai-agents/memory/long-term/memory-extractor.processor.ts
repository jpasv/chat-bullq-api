import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PrismaService } from '../../../../database/prisma.service';
import { LongTermMemoryService } from './long-term.service';
import {
  ExtractionMessage,
  MemoryExtractorJobData,
} from './long-term.types';
import { MemoryExtractorService } from './memory-extractor.service';

/** Queue name — register with `BullModule.registerQueue({ name: MEMORY_EXTRACTOR_QUEUE })`. */
export const MEMORY_EXTRACTOR_QUEUE = 'memory-extractor';

/**
 * BullMQ worker that runs the Fugu extractor after each successful agent
 * run. Enqueued by the runner (Agent 7's territory) — this processor just
 * pulls the last 20 turns, asks Fugu what changed, and persists the diff.
 *
 * Concurrency is intentionally low: extraction is async and not on the
 * critical path for replying to the user, so we don't need to scale it
 * aggressively. Cost matters more than latency here.
 */
@Processor(MEMORY_EXTRACTOR_QUEUE, { concurrency: 2 })
export class MemoryExtractorProcessor extends WorkerHost {
  private readonly logger = new Logger(MemoryExtractorProcessor.name);

  constructor(
    private readonly extractor: MemoryExtractorService,
    private readonly memory: LongTermMemoryService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(
    job: Job<MemoryExtractorJobData>,
  ): Promise<{ ok: boolean; factsAdded: number; factsRemoved: number; costUsd: number }> {
    const { agentId, contactId, conversationId } = job.data;

    // Pull the last 20 messages (most-recent first), then reverse to get
    // chronological order for the extractor prompt.
    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    if (messages.length === 0) {
      this.logger.debug(
        `Skipping extraction — no messages on conversation=${conversationId}`,
      );
      return { ok: true, factsAdded: 0, factsRemoved: 0, costUsd: 0 };
    }

    const recent: ExtractionMessage[] = messages
      .slice()
      .reverse()
      .map((m) => ({
        role: m.direction === 'INBOUND' ? 'user' : 'assistant',
        content: this.extractMessageText(m.content),
        createdAt: m.createdAt.toISOString(),
      }))
      .filter((m) => m.content.trim().length > 0);

    if (recent.length === 0) {
      this.logger.debug(
        `Skipping extraction — no textual content on conversation=${conversationId}`,
      );
      return { ok: true, factsAdded: 0, factsRemoved: 0, costUsd: 0 };
    }

    const currentMemory = await this.memory.getOrCreate(agentId, contactId);

    const result = await this.extractor.extract({
      agentId,
      contactId,
      recentMessages: recent,
      currentMemory,
    });

    if (result.newFacts.length > 0 || result.factsToRemove.length > 0) {
      await this.memory.upsertFacts(
        agentId,
        contactId,
        result.newFacts,
        result.factsToRemove,
      );
    }

    if (result.summaryUpdate) {
      await this.memory.updateSummary(agentId, contactId, result.summaryUpdate);
    }

    this.logger.log(
      `memory_extracted agent=${agentId} contact=${contactId} added=${result.newFacts.length} removed=${result.factsToRemove.length} cost=$${result.costUsd.toFixed(6)}`,
    );

    return {
      ok: true,
      factsAdded: result.newFacts.length,
      factsRemoved: result.factsToRemove.length,
      costUsd: result.costUsd,
    };
  }

  /**
   * Message.content is a JSON column with the shape `{ text, ... }` for
   * TEXT messages and provider-specific shapes for media. We return the
   * text body when present and a placeholder otherwise so the extractor
   * still has signal that "an audio was sent".
   */
  private extractMessageText(content: unknown): string {
    if (!content || typeof content !== 'object') return '';
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text;
    if (typeof c.body === 'string') return c.body;
    if (typeof c.caption === 'string') return c.caption;
    return '';
  }
}
