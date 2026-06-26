import { Injectable, Logger } from '@nestjs/common';

import { LlmService } from '../../llm/llm.service';
import { SAKANA_SIMPLE_MODEL } from '../../llm/llm.constants';
import {
  ExtractionInput,
  ExtractionResult,
  MemoryFact,
} from './long-term.types';

/**
 * Memory extractor — uses cheap Sakana Fugu to read the recent
 * conversation + the current memory and emit:
 *   - `newFacts`: facts that aren't already known
 *   - `factsToRemove`: facts that became stale or contradicted
 *   - `summaryUpdate`: a refreshed 1-paragraph summary (or null)
 *
 * This is the cheap pass we run after every successful agent run. The model is fixed to the cheaper Fugu path because extraction is a structured, low-creativity task and cost scales linearly with conversation volume.
 */
@Injectable()
export class MemoryExtractorService {
  private readonly logger = new Logger(MemoryExtractorService.name);
  private readonly modelId = SAKANA_SIMPLE_MODEL;

  constructor(private readonly llm: LlmService) {}

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(input);

    let response;
    try {
      response = await this.llm.complete({
        modelId: this.modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxTokens: 1000,
        temperature: 0.2,
      });
    } catch (err) {
      this.logger.error(
        `Fugu extraction failed agent=${input.agentId} contact=${input.contactId}: ${(err as Error).message}`,
      );
      return this.emptyResult();
    }

    const content =
      typeof response.message.content === 'string'
        ? response.message.content
        : response.message.content
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('');

    const parsed = this.tolerantParse(content);
    if (!parsed) {
      this.logger.warn(
        `Fugu returned non-JSON for agent=${input.agentId} contact=${input.contactId}: ${content.slice(0, 200)}`,
      );
      return { ...this.emptyResult(), costUsd: response.usage.costUsd };
    }

    return {
      newFacts: this.normalizeFacts(parsed.newFacts),
      factsToRemove: this.normalizeFactStrings(parsed.factsToRemove),
      summaryUpdate:
        typeof parsed.summaryUpdate === 'string' && parsed.summaryUpdate.trim().length > 0
          ? parsed.summaryUpdate.trim()
          : null,
      reasoning:
        typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      costUsd: response.usage.costUsd,
    };
  }

  // ─── prompt construction ────────────────────────────────────────────

  private buildSystemPrompt(): string {
    return `Você é um extrator de fatos sobre clientes a partir de conversas de atendimento.

Dado o histórico recente e a memória atual, retorne UM ÚNICO JSON com esta estrutura exata:
{
  "newFacts": [
    { "fact": "Cliente tem CNPJ 12.345.678/0001-90", "category": "identity", "confidence": 0.95 }
  ],
  "factsToRemove": ["Cliente prefere ser contatado por email"],
  "summaryUpdate": "Cliente PJ do segmento XYZ, conversando sobre orçamento do produto Y...",
  "reasoning": "Explicação curta do que mudou"
}

Regras estritas:
- Foque em fatos OBJETIVOS observados nas mensagens (CNPJ, profissão, produto comprado, problema, preferência declarada).
- NÃO invente — só registre o que está literal nas mensagens.
- Cada "fact" tem no máximo 1 frase curta (até 120 caracteres).
- "category" deve ser um dos: "identity", "preference", "history", "context".
- "confidence" entre 0 e 1.
- "newFacts" só inclui fatos que NÃO estão na memória atual.
- "factsToRemove" só inclui fatos da memória atual que ficaram contraditórios ou obsoletos.
- "summaryUpdate" é null se nada relevante mudou; caso contrário, 1 parágrafo curto (até 400 caracteres).
- Retorne apenas o JSON, sem texto antes ou depois.`;
  }

  private buildUserPrompt(input: ExtractionInput): string {
    const memorySection = input.currentMemory
      ? `Summary atual: ${input.currentMemory.summary ?? '(vazio)'}\nFacts atuais: ${JSON.stringify(input.currentMemory.facts.map((f) => ({ fact: f.fact, category: f.category })))}`
      : 'Memória atual: (vazia, primeiro contato com este cliente)';

    const conversation = input.recentMessages
      .map((m) => `${m.role}: ${this.truncate(m.content, 500)}`)
      .join('\n');

    return `${memorySection}

Conversa recente (ordem cronológica):
${conversation}

Extraia em JSON.`;
  }

  // ─── parsing helpers ────────────────────────────────────────────────

  /**
   * Tries `JSON.parse` straight away, then falls back to extracting the
   * first `{...}` block from the output. Fugu occasionally wraps JSON
   * in markdown fences or adds a leading sentence even when asked not to.
   */
  private tolerantParse(raw: string): Record<string, unknown> | null {
    const direct = this.tryJson(raw);
    if (direct) return direct;
    const stripped = raw.replace(/```json|```/g, '').trim();
    const directStripped = this.tryJson(stripped);
    if (directStripped) return directStripped;
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) return this.tryJson(match[0]);
    return null;
  }

  private tryJson(s: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(s);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private normalizeFacts(raw: unknown): MemoryFact[] {
    if (!Array.isArray(raw)) return [];
    const now = new Date().toISOString();
    const out: MemoryFact[] = [];
    for (const item of raw) {
      if (typeof item === 'string' && item.trim().length > 0) {
        out.push({
          fact: item.trim(),
          confidence: 0.8,
          extractedAt: now,
          source: 'auto',
        });
        continue;
      }
      if (item && typeof item === 'object') {
        const r = item as Record<string, unknown>;
        if (typeof r.fact !== 'string' || r.fact.trim().length === 0) continue;
        out.push({
          fact: r.fact.trim(),
          category: typeof r.category === 'string' ? r.category : undefined,
          confidence:
            typeof r.confidence === 'number' ? r.confidence : 0.8,
          extractedAt: now,
          source: 'auto',
        });
      }
    }
    return out;
  }

  private normalizeFactStrings(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter((x) => x.length > 0);
  }

  private truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return `${s.slice(0, max)}...`;
  }

  private emptyResult(): ExtractionResult {
    return {
      newFacts: [],
      factsToRemove: [],
      summaryUpdate: null,
      reasoning: '',
      costUsd: 0,
    };
  }
}
