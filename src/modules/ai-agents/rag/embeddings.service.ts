import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmbeddingResult } from './types';

/**
 * Generates embeddings via the OpenAI Embeddings API (`text-embedding-3-small`,
 * 1536 dims, ~$0.02 per 1M tokens). Anthropic does not provide an embeddings
 * endpoint, so this is the one place we still depend on OpenAI.
 *
 * The service is stateless: each call is one HTTP request. Batching is
 * supported via `embedBatch` to amortize round-trip latency when indexing
 * many messages at once.
 */
@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);
  private readonly MODEL = 'text-embedding-3-small';
  /** USD cost per 1M tokens for `text-embedding-3-small`. */
  private readonly COST_PER_1M_TOKENS = 0.02;
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    const apiKey =
      config.get<string>('OPENAI_API_KEY') ?? process.env.OPENAI_API_KEY ?? '';
    if (!apiKey) {
      this.logger.warn(
        'No OPENAI_API_KEY set — embeddings will fail at runtime',
      );
    }
    this.apiKey = apiKey;
  }

  /**
   * Embeds a single string. Returns the vector + cost metadata so the
   * caller can log it against the agent run's budget.
   */
  async embed(text: string): Promise<EmbeddingResult> {
    const t0 = Date.now();
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.MODEL, input: text }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Embeddings API ${response.status}: ${body.slice(0, 300)}`,
      );
      throw new InternalServerErrorException(
        `Embeddings API error (${response.status}): ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
      usage: { total_tokens: number };
    };

    const tokensUsed = data.usage?.total_tokens ?? 0;
    const costUsd = (tokensUsed / 1_000_000) * this.COST_PER_1M_TOKENS;

    this.logger.log(
      `embedding_generated tokens=${tokensUsed} costUsd=${costUsd.toFixed(6)} durationMs=${Date.now() - t0}`,
    );

    return {
      vector: data.data[0].embedding,
      model: this.MODEL,
      tokensUsed,
      costUsd,
    };
  }

  /**
   * Embeds N strings in a single API call. Order is preserved — the
   * returned array is parallel to `texts`.
   *
   * Each `EmbeddingResult` reports the per-call totals divided evenly
   * across inputs so the caller can attribute cost back to each item
   * (the API itself only returns one aggregate token count).
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    const t0 = Date.now();
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.MODEL, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Embeddings batch API ${response.status}: ${body.slice(0, 300)}`,
      );
      throw new InternalServerErrorException(
        `Embeddings batch API error (${response.status}): ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
      usage: { total_tokens: number };
    };

    const totalTokens = data.usage?.total_tokens ?? 0;
    const totalCost = (totalTokens / 1_000_000) * this.COST_PER_1M_TOKENS;
    // Even split — caller can do better attribution if it has per-text token counts.
    const perCallTokens = Math.round(totalTokens / texts.length);
    const perCallCost = totalCost / texts.length;

    this.logger.log(
      `embedding_batch_generated count=${texts.length} totalTokens=${totalTokens} totalCostUsd=${totalCost.toFixed(6)} durationMs=${Date.now() - t0}`,
    );

    // Sort by `index` to be safe — the API documents stable order, but
    // explicit is cheaper than a future bug.
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    return sorted.map((item) => ({
      vector: item.embedding,
      model: this.MODEL,
      tokensUsed: perCallTokens,
      costUsd: perCallCost,
    }));
  }
}
