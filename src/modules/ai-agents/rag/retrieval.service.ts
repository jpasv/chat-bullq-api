import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';
import { RerankerService } from './reranker.service';
import { VectorStoreService } from './vector-store.service';
import { DEFAULT_RAG_CONFIG, type SearchQuery, type SearchResult } from './types';

/**
 * High-level RAG entry point — what the prompt composer (Layer 4 CONTEXT)
 * calls to fetch relevant snippets for the current turn.
 *
 * Pipeline:
 *   1. Embed the query string (1 OpenAI call).
 *   2. Run cosine similarity search in the vector store, scoped by
 *      agent / contact / conversation / owner type.
 *   3. Optionally rerank with the cheap Fugu model (off by default — keep it cheap).
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    private readonly embeddings: EmbeddingsService,
    private readonly store: VectorStoreService,
    private readonly reranker: RerankerService,
  ) {}

  async retrieve(
    input: SearchQuery & { rerank?: boolean },
  ): Promise<SearchResult[]> {
    const t0 = Date.now();
    const k = input.k ?? DEFAULT_RAG_CONFIG.k;
    const minScore = input.minScore ?? DEFAULT_RAG_CONFIG.minScore;

    const emb = await this.embeddings.embed(input.query);
    let results = await this.store.search(emb.vector, input.scope, k, minScore);

    const shouldRerank = input.rerank ?? DEFAULT_RAG_CONFIG.rerankEnabled;
    if (shouldRerank && results.length > 1) {
      results = await this.reranker.rerank(input.query, results);
    }

    this.logger.log(
      `retrieve k=${k} minScore=${minScore} hits=${results.length} rerank=${shouldRerank} durationMs=${Date.now() - t0}`,
    );

    return results;
  }
}
