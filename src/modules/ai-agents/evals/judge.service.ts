import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { JudgeVerdict } from './types';

const JUDGE_MODEL = 'claude-haiku-4-5';

const JUDGE_SYSTEM_PROMPT = `Você é um juiz imparcial que avalia respostas de agents de IA.

Sua tarefa: receber uma pergunta de avaliação e a resposta do agent, e responder se ela atende ao critério.

Você DEVE responder estritamente neste formato (JSON em uma única linha):
{"verdict":"pass","reasoning":"explicação curta em português, máx 1 frase"}

ou

{"verdict":"fail","reasoning":"explicação curta em português, máx 1 frase"}

Não inclua nenhum outro texto antes ou depois do JSON.`;

/**
 * LLM-as-judge para asserções subjetivas em evals (tom, clareza, empatia,
 * aderência a um padrão de copy). Usa Claude 3.5 Haiku via OpenRouter — é
 * barato, rápido e suficiente pro nível de avaliação binária pass/fail.
 */
@Injectable()
export class JudgeService {
  private readonly logger = new Logger(JudgeService.name);

  constructor(private readonly llm: LlmService) {}

  /**
   * Pergunta ao juiz se a resposta do agent satisfaz o critério passado.
   *
   * @param question - critério/pergunta subjetiva (ex.: "a resposta usa tom empático?")
   * @param response - mensagem final do agent que será avaliada
   */
  async evaluate(question: string, response: string): Promise<JudgeVerdict> {
    const userPrompt = [
      'Pergunta de avaliação:',
      question,
      '',
      'Resposta do agent:',
      response,
      '',
      'Responda apenas com o JSON no formato especificado.',
    ].join('\n');

    try {
      const completion = await this.llm.complete({
        modelId: JUDGE_MODEL,
        temperature: 0,
        maxTokens: 256,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      });

      const raw =
        typeof completion.message.content === 'string'
          ? completion.message.content
          : completion.message.content.map((p) => p.text).join('');

      const verdict = this.parseVerdict(raw);
      this.logger.log({
        msg: 'judge_evaluated',
        verdict: verdict.verdict,
        costUsd: completion.usage.costUsd,
      });
      return verdict;
    } catch (err: any) {
      this.logger.error(
        `Judge call failed: ${err?.message ?? 'unknown'} — defaulting to fail`,
      );
      return {
        verdict: 'fail',
        reasoning: `Judge error: ${err?.message ?? 'unknown'}`,
      };
    }
  }

  private parseVerdict(raw: string): JudgeVerdict {
    const trimmed = raw.trim();

    // The judge sometimes wraps the JSON in code fences — strip them.
    const cleaned = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    // Be lenient: find the first {...} block in the output.
    const match = cleaned.match(/\{[\s\S]*\}/);
    const candidate = match ? match[0] : cleaned;

    try {
      const parsed = JSON.parse(candidate);
      const verdict =
        parsed?.verdict === 'pass' || parsed?.verdict === 'fail'
          ? parsed.verdict
          : 'fail';
      const reasoning =
        typeof parsed?.reasoning === 'string'
          ? parsed.reasoning
          : 'no reasoning provided';
      return { verdict, reasoning };
    } catch {
      this.logger.warn(`Judge returned unparseable verdict: ${raw.slice(0, 200)}`);
      return {
        verdict: 'fail',
        reasoning: `Unparseable judge output: ${raw.slice(0, 120)}`,
      };
    }
  }
}
