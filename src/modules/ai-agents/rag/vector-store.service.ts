import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { SearchResult, SearchScope, VectorEntry } from './types';

/**
 * Postgres + pgvector backed store for RAG entries.
 *
 * The schema is NOT in `prisma.schema` yet — pgvector is a Postgres
 * extension that Prisma can't model natively (it would treat `vector(1536)`
 * as `Unsupported`). We talk to the table via raw SQL through Prisma.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  MIGRATION SQL (run manually in Phase 2 — NOT executed by this code):
 * ─────────────────────────────────────────────────────────────────────
 *
 *  CREATE EXTENSION IF NOT EXISTS vector;
 *
 *  CREATE TABLE ai_vector_entries (
 *    id              text PRIMARY KEY,
 *    owner_type      text NOT NULL,           -- 'message' | 'fact' | 'memory_summary'
 *    owner_id        text NOT NULL,           -- FK in the source domain
 *    conversation_id text,
 *    agent_id        text,
 *    contact_id      text,
 *    content         text NOT NULL,           -- original text (returned at search time)
 *    embedding       vector(1536) NOT NULL,   -- text-embedding-3-small dims
 *    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
 *    created_at      timestamptz NOT NULL DEFAULT now()
 *  );
 *
 *  -- Filter indexes for the scope predicates.
 *  CREATE INDEX ai_vector_entries_owner_idx        ON ai_vector_entries(owner_type, owner_id);
 *  CREATE INDEX ai_vector_entries_conversation_idx ON ai_vector_entries(conversation_id);
 *  CREATE INDEX ai_vector_entries_agent_idx        ON ai_vector_entries(agent_id);
 *  CREATE INDEX ai_vector_entries_contact_idx      ON ai_vector_entries(contact_id);
 *
 *  -- Approximate nearest neighbour index for cosine distance.
 *  -- HNSW does not require existing data to train the index.
 *  CREATE INDEX ai_vector_entries_embedding_idx
 *    ON ai_vector_entries
 *    USING hnsw (embedding vector_cosine_ops);
 *
 *  -- After bulk inserts, run:  ANALYZE ai_vector_entries;
 *
 * ─────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class VectorStoreService {
  private readonly logger = new Logger(VectorStoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inserts or updates a single vector entry. Uses `ON CONFLICT (id) DO
   * UPDATE` so re-indexing a message overwrites instead of duplicating.
   */
  async upsert(entry: VectorEntry): Promise<void> {
    const vectorLiteral = this.toVectorLiteral(entry.embedding);

    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO ai_vector_entries
        (id, owner_type, owner_id, conversation_id, agent_id, contact_id, content, embedding, metadata)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        embedding = EXCLUDED.embedding,
        content   = EXCLUDED.content,
        metadata  = EXCLUDED.metadata
      `,
      entry.id,
      entry.ownerType,
      entry.ownerId,
      entry.conversationId ?? null,
      entry.agentId ?? null,
      entry.contactId ?? null,
      entry.content,
      vectorLiteral,
      JSON.stringify(entry.metadata ?? {}),
    );
  }

  /**
   * Bulk-upsert. Currently a sequential loop — pgvector + Prisma raw
   * doesn't ergonomically express a multi-row VALUES with vector casts,
   * and the indexer queue is concurrent at the job level anyway. If
   * throughput becomes a bottleneck, switch to `INSERT ... SELECT FROM
   * unnest(...)` with parallel arrays.
   */
  async upsertMany(entries: VectorEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.upsert(entry);
    }
  }

  /**
   * Cosine similarity search.
   *
   * `embedding <=> $1::vector` is the pgvector cosine *distance* operator
   * (0 = identical, 2 = opposite). We convert to similarity via `1 - d`
   * so the score returned to the caller is the familiar 0..1 range
   * (higher = more similar).
   */
  async search(
    queryVector: number[],
    scope: SearchScope,
    k = 5,
    minScore = 0.7,
  ): Promise<SearchResult[]> {
    const vec = this.toVectorLiteral(queryVector);

    const filters: string[] = [];
    const params: any[] = [vec, k];
    let p = 3;

    if (scope.agentId) {
      filters.push(`agent_id = $${p++}`);
      params.push(scope.agentId);
    }
    if (scope.contactId) {
      filters.push(`contact_id = $${p++}`);
      params.push(scope.contactId);
    }
    if (scope.conversationId) {
      filters.push(`conversation_id = $${p++}`);
      params.push(scope.conversationId);
    }
    if (scope.ownerType && scope.ownerType !== 'any') {
      filters.push(`owner_type = $${p++}`);
      params.push(scope.ownerType);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, any>>>(
      `
      SELECT
        id,
        owner_type,
        owner_id,
        conversation_id,
        agent_id,
        contact_id,
        content,
        metadata,
        created_at,
        1 - (embedding <=> $1::vector) AS score
      FROM ai_vector_entries
      ${where}
      ORDER BY embedding <=> $1::vector ASC
      LIMIT $2
      `,
      ...params,
    );

    return rows
      .filter((r) => Number(r.score) >= minScore)
      .map((r) => ({
        entry: {
          id: r.id,
          ownerType: r.owner_type,
          ownerId: r.owner_id,
          conversationId: r.conversation_id ?? undefined,
          agentId: r.agent_id ?? undefined,
          contactId: r.contact_id ?? undefined,
          content: r.content,
          embedding: [], // search omits the raw vector to save bandwidth
          metadata: r.metadata ?? {},
          createdAt:
            r.created_at instanceof Date
              ? r.created_at.toISOString()
              : String(r.created_at),
        },
        score: Number(r.score),
      }));
  }

  async delete(id: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM ai_vector_entries WHERE id = $1`,
      id,
    );
  }

  /**
   * Removes every entry tied to a given owner. Useful when a fact is
   * deleted upstream and we want the vector store to reflect that.
   */
  async deleteByOwner(ownerType: VectorEntry['ownerType'], ownerId: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM ai_vector_entries WHERE owner_type = $1 AND owner_id = $2`,
      ownerType,
      ownerId,
    );
  }

  /**
   * pgvector accepts both binary and text representations. The text form
   * `'[1,2,3]'::vector` is what the Postgres driver passes through
   * cleanly without binary protocol gymnastics.
   */
  private toVectorLiteral(vector: number[]): string {
    return `[${vector.join(',')}]`;
  }
}
