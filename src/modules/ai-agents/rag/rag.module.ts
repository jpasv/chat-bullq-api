import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../database/prisma.module';
import { LlmModule } from '../llm/llm.module';
import { EmbeddingsService } from './embeddings.service';
import { VectorStoreService } from './vector-store.service';
import { RetrievalService } from './retrieval.service';
import { RerankerService } from './reranker.service';
import { RagIndexerProcessor } from './indexer.processor';

/**
 * RAG (Retrieval-Augmented Generation) module.
 *
 * Wires up:
 *  - `EmbeddingsService`     OpenAI embeddings (text-embedding-3-small)
 *  - `VectorStoreService`    Postgres + pgvector raw SQL via Prisma
 *  - `RetrievalService`      embed → search → optional rerank
 *  - `RerankerService`       Haiku-based relevance re-ranker (optional)
 *  - `RagIndexerProcessor`   BullMQ worker on `rag-indexer` queue
 *
 * NOTE: the `ai_vector_entries` table + pgvector extension are NOT in
 * `prisma.schema` — they need to be created via a manual migration in
 * Phase 2. See the SQL block at the top of `vector-store.service.ts`.
 *
 * Exports the high-level services so the agent runner / prompt composer
 * can call `RetrievalService.retrieve(...)` from Layer 4 CONTEXT.
 */
const ragIndexerQueue = BullModule.registerQueue({ name: 'rag-indexer' });

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    LlmModule,
    ragIndexerQueue,
  ],
  providers: [
    EmbeddingsService,
    VectorStoreService,
    RerankerService,
    RetrievalService,
    RagIndexerProcessor,
  ],
  exports: [
    EmbeddingsService,
    VectorStoreService,
    RetrievalService,
    RerankerService,
    // Re-exporta a registração da queue pra que módulos que importam RagModule
    // (ex: AiAgentsModule) consigam @InjectQueue('rag-indexer').
    ragIndexerQueue,
  ],
})
export class RagModule {}
