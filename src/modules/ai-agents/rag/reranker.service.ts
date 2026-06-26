import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import type { LlmMessage } from '../llm/llm.types';
import { DEFAULT_RAG_CONFIG, type SearchResult } from './types';

/**
 * Optional second pass after vector search. The vector store gives us
 * the top-K by raw cosine similarity, but cosine similarity doesn't know
 * what the query is *asking* — only what it's *similar to*. A small,
 * fast LLM (Fugu) can cheaply re-order the K candidates by actual
 * relevance to the question.
 *
 * This is a stub: it preserves the candidate scores but exposes the
 * orchestration shape Phase 2 will fill in. When `rerankEnabled` is off
 * (the default) the retrieval service skips this entirely.
 */
@Injectable()
export class RerankerService {
  private readonly logger = new Logger(RerankerService.name);
  private readonly RERANKER_MODEL = DEFAULT_RAG_CONFIG.rerankerModel;

  constructor(private readonly llm: LlmService) {}

  /**
   * Re-orders `candidates` by relevance to `query`. Returns the same
   * objects (same scores) in a possibly-different order. When the LLM
   * call fails or returns an unparseable response, falls back to the
   * input order (cosine ranking) so the caller never gets fewer
   * results than it asked for.
   */
  async rerank(
    query: string,
    candidates: SearchResult[],
  ): Promise<SearchResult[]> {
    if (candidates.length <= 1) return candidates;

    const t0 = Date.now();
    const indexed = candidates.map((c, i) => ({ idx: i, content: c.entry.content }));

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content:
          'You are a relevance ranker. Given a user query and a list of candidate passages, return a JSON array of passage indices ordered from most to least relevant to the query. Output ONLY the JSON array, nothing else.',
      },
      {
        role: 'user',
        content: this.buildPrompt(query, indexed),
      },
    ];

    try {
      const response = await this.llm.complete({
        modelId: this.RERANKER_MODEL,
        messages,
        temperature: 0,
        maxTokens: 256,
      });

      const text =
        typeof response.message.content === 'string'
          ? response.message.content
          : response.message.content
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('');

      const order = this.parseOrder(text, candidates.length);
      if (!order) {
        this.logger.warn(
          `reranker_parse_failed — falling back to cosine order. raw="${text.slice(0, 200)}"`,
        );
        return candidates;
      }

      this.logger.log(
        `reranker_ok candidates=${candidates.length} durationMs=${Date.now() - t0}`,
      );

      return order.map((i) => candidates[i]);
    } catch (err) {
      this.logger.warn(
        `reranker_failed — falling back to cosine order: ${(err as Error)?.message ?? err}`,
      );
      return candidates;
    }
  }

  private buildPrompt(
    query: string,
    candidates: { idx: number; content: string }[],
  ): string {
    const lines = candidates.map(
      (c) => `[${c.idx}] ${c.content.replace(/\s+/g, ' ').slice(0, 300)}`,
    );
    return [
      `Query: ${query}`,
      '',
      'Candidates:',
      ...lines,
      '',
      'Return a JSON array of indices, most relevant first. Example: [3,0,1,2]',
    ].join('\n');
  }

  /**
   * Tolerant parser — accepts a plain JSON array or a JSON array embedded
   * in surrounding prose. Validates that every returned index is in
   * range and that we got the same count back as we sent.
   */
  private parseOrder(text: string, expectedLength: number): number[] | null {
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    if (parsed.length !== expectedLength) return null;
    const seen = new Set<number>();
    const out: number[] = [];
    for (const v of parsed) {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n) || n < 0 || n >= expectedLength) return null;
      if (seen.has(n)) return null;
      seen.add(n);
      out.push(n);
    }
    return out;
  }
}
