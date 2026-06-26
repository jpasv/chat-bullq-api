import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { LlmMessage } from '../llm/llm.types';
import { SAKANA_SIMPLE_MODEL } from '../llm/llm.constants';
import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierUserPrompt,
} from './classifier.prompt';
import {
  ClassificationResult,
  ClassifierConfig,
  ClassifierMessage,
  IntentType,
} from './intent.types';
import { IntentRouterService } from './intent-router.service';

/**
 * Camada leve de pré-roteamento que roda antes do orchestrator (Augusto).
 *
 * Fluxo:
 *  1. Pega a mensagem (e até 3 do histórico) e manda pro Fugu via LlmService
 *     pedindo um JSON estruturado.
 *  2. Faz parsing tolerante — se o modelo voltar markdown ou texto extra,
 *     ainda extrai o JSON de dentro.
 *  3. Decide se o orchestrator pode ser pulado: precisa de confidence acima
 *     do threshold E intent direcionável (não AMBIGUOUS/SPAM/ESCALATE/SMALL).
 *  4. Estima custo da chamada — se o LlmService já trouxe `usage.costUsd`,
 *     usa direto; caso contrário, calcula com base nos tokens (Fugu tem
 *     custo retornado pelo provider).
 *
 * Erros NÃO derrubam a request: se o classifier falhar, devolve um result
 * com intent=AMBIGUOUS pra forçar fallback no orchestrator.
 */
@Injectable()
export class IntentClassifierService {
  private readonly logger = new Logger(IntentClassifierService.name);
  private readonly DEFAULT_MODEL = SAKANA_SIMPLE_MODEL;
  private readonly DEFAULT_THRESHOLD = 0.85;

  constructor(
    private readonly llm: LlmService,
    private readonly intentRouter: IntentRouterService,
  ) {}

  async classify(
    message: string,
    recentMessages?: ClassifierMessage[],
    config?: Partial<ClassifierConfig>,
  ): Promise<ClassificationResult> {
    const t0 = Date.now();
    const model = config?.model ?? this.DEFAULT_MODEL;
    const threshold = config?.threshold ?? this.DEFAULT_THRESHOLD;

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: [
          { type: 'text', text: CLASSIFIER_SYSTEM_PROMPT, cache: true },
        ],
      },
      {
        role: 'user',
        content: buildClassifierUserPrompt(message, recentMessages),
      },
    ];

    try {
      const resp = await this.llm.complete({
        modelId: model,
        messages,
        temperature: 0,
        maxTokens: 200,
      });

      const raw =
        typeof resp.message.content === 'string'
          ? resp.message.content
          : resp.message.content
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('');

      const parsed = this.parseClassifierJson(raw);
      const intent = this.normalizeIntent(parsed?.intent);
      const confidence = this.normalizeConfidence(parsed?.confidence);
      const reasoning =
        typeof parsed?.reasoning === 'string'
          ? parsed.reasoning.slice(0, 300)
          : '';
      const suggestedAgent =
        typeof parsed?.suggestedAgent === 'string' && parsed.suggestedAgent
          ? parsed.suggestedAgent
          : null;

      // Decisão final de skip leva em conta tanto o threshold quanto a
      // categoria do intent — AMBIGUOUS/SPAM/ESCALATE/SMALL_TALK SEMPRE
      // caem no orchestrator, mesmo com confidence alta.
      const route = this.intentRouter.routeIntent(intent);
      const skippedOrchestrator =
        route.shouldSkipOrchestrator && confidence >= threshold;

      const costUsd = resp.usage.costUsd;

      const durationMs = Date.now() - t0;

      const result: ClassificationResult = {
        intent,
        confidence,
        reasoning,
        suggestedAgent: suggestedAgent ?? route.agentName ?? null,
        skippedOrchestrator,
        modelUsed: resp.rawModelId ?? model,
        costUsd,
        durationMs,
      };

      this.logger.log(
        JSON.stringify({
          msg: 'intent_classified',
          intent: result.intent,
          confidence: result.confidence,
          skipped: result.skippedOrchestrator,
          costUsd: Number(result.costUsd.toFixed(6)),
          durationMs: result.durationMs,
          model: result.modelUsed,
        }),
      );

      return result;
    } catch (err: any) {
      // Falha no classifier não pode quebrar a request — devolve AMBIGUOUS
      // pra forçar o fallback no orchestrator e loga o motivo.
      const durationMs = Date.now() - t0;
      this.logger.warn(
        JSON.stringify({
          msg: 'intent_classifier_failed',
          error: err?.message ?? String(err),
          durationMs,
        }),
      );
      return {
        intent: IntentType.AMBIGUOUS,
        confidence: 0,
        reasoning: `classifier failed: ${err?.message ?? 'unknown'}`,
        suggestedAgent: null,
        skippedOrchestrator: false,
        modelUsed: model,
        costUsd: 0,
        durationMs,
      };
    }
  }

  /**
   * Parse tolerante: tenta JSON.parse direto, senão extrai o primeiro
   * objeto JSON de dentro do texto (modelos às vezes embrulham em ```json).
   */
  private parseClassifierJson(raw: string): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();

    // Caminho feliz.
    try {
      return JSON.parse(trimmed);
    } catch {
      // segue pro fallback
    }

    // Tira fences de markdown (```json ... ``` ou ``` ... ```).
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // segue pro último fallback
      }
    }

    // Último recurso: pega o primeiro {...} balanceado.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const slice = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }

    return null;
  }

  private normalizeIntent(raw: unknown): IntentType {
    if (typeof raw !== 'string') return IntentType.AMBIGUOUS;
    const upper = raw.trim().toUpperCase().replace(/\s+/g, '_');
    if ((Object.values(IntentType) as string[]).includes(upper)) {
      return upper as IntentType;
    }
    return IntentType.AMBIGUOUS;
  }

  private normalizeConfidence(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return n > 1.5 ? n / 100 : 1; // tolera "85" (=0.85) ou "0.85"
    return n;
  }
}
