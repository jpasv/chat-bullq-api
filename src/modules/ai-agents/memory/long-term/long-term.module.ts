import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { PrismaModule } from '../../../../database/prisma.module';
import { LlmModule } from '../../llm/llm.module';
import { ContextEnrichmentService } from './context-enrichment.service';
import { LongTermMemoryService } from './long-term.service';
import { MemoryExtractorProcessor, MEMORY_EXTRACTOR_QUEUE } from './memory-extractor.processor';
import { MemoryExtractorService } from './memory-extractor.service';

/**
 * Long-term memory module.
 *
 * Exposes:
 *   - `LongTermMemoryService`     — CRUD over `ai_agent_memories`
 *   - `MemoryExtractorService`    — Fugu-powered fact extractor (callable
 *                                   directly, not just from the worker)
 *   - `ContextEnrichmentService`  — builds the Layer-4 `EnrichedContext`
 *                                   payload for the prompt composer
 *
 * Registers the BullMQ queue `memory-extractor` and its worker so the
 * runner can enqueue an extraction job after each successful run.
 */
@Module({
  imports: [
    PrismaModule,
    LlmModule,
    BullModule.registerQueue({ name: MEMORY_EXTRACTOR_QUEUE }),
  ],
  providers: [
    LongTermMemoryService,
    MemoryExtractorService,
    MemoryExtractorProcessor,
    ContextEnrichmentService,
  ],
  exports: [
    LongTermMemoryService,
    MemoryExtractorService,
    ContextEnrichmentService,
    BullModule,
  ],
})
export class LongTermMemoryModule {}
