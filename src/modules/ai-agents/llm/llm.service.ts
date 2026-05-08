import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

import {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
  LlmUsage,
} from './llm.types';

/**
 * Cliente da Anthropic API (Claude).
 *
 * - Mantém a interface pública (`complete()`, `LlmMessage`, etc).
 * - Aceita modelId já no formato Anthropic (`claude-sonnet-4-6`) ou com
 *   prefix `anthropic/` por retrocompat — o prefix é despido antes da
 *   chamada.
 * - Prompt caching ephemeral nativo: `system` em blocks com cache_control,
 *   tools com cache no último elemento.
 * - Custo calculado client-side (Anthropic não retorna `cost` no response).
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly client: Anthropic;
  private readonly hasApiKey: boolean;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    this.hasApiKey = !!apiKey;
    if (!apiKey) {
      this.logger.warn(
        'ANTHROPIC_API_KEY not set — AI agents will fail at runtime',
      );
    }
    this.client = new Anthropic({ apiKey: apiKey ?? 'missing' });
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const modelId = this.normalizeModelId(req.modelId);
    const { system, messages } = this.toAnthropicMessages(req.messages);
    const tools = req.tools
      ? this.toAnthropicTools(this.sanitizeTools(req.tools))
      : undefined;

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: modelId,
        max_tokens: req.maxTokens ?? 2048,
        temperature: req.temperature ?? 0.7,
        ...(system ? { system } : {}),
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(this.sanitizeModelParams(req.modelParams) as object),
      });
    } catch (err: unknown) {
      this.handleAnthropicError(err, modelId, tools, messages, system);
      throw new InternalServerErrorException(
        `LLM provider error: ${this.errorMessage(err)}`,
      );
    }

    const message = this.fromAnthropicMessage(response);
    const stopReason = this.normalizeStopReason(response.stop_reason);
    const usage = this.extractUsage(response.usage, modelId);

    return {
      message,
      stopReason,
      usage,
      rawModelId: response.model ?? modelId,
    };
  }

  // ─── conversão: nossos tipos → Anthropic SDK ─────────────────────

  /**
   * Aceita IDs com prefix `anthropic/` por retrocompat (formato antigo) e
   * retorna o ID exato que a Anthropic API espera.
   */
  private normalizeModelId(id: string): string {
    if (id.startsWith('anthropic/')) return id.slice('anthropic/'.length);
    return id;
  }

  /**
   * Converte nosso array `LlmMessage[]` (formato OpenAI-like com role
   * 'system'/'tool' soltos) pro shape Anthropic:
   *   - `system`: blocks separados (não no array de messages).
   *   - `messages`: só user/assistant; tool results viram blocks
   *     `tool_result` dentro de uma user message; tool calls viram
   *     blocks `tool_use` dentro de uma assistant message.
   *   - mensagens 'tool' consecutivas são agrupadas numa única user
   *     message com múltiplos tool_result blocks (formato canônico).
   */
  private toAnthropicMessages(input: LlmMessage[]): {
    system?: Anthropic.TextBlockParam[];
    messages: Anthropic.MessageParam[];
  } {
    let system: Anthropic.TextBlockParam[] | undefined;
    const out: Anthropic.MessageParam[] = [];
    let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

    const flushToolResults = () => {
      if (pendingToolResults.length === 0) return;
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    };

    for (const m of input) {
      if (m.role === 'system') {
        const blocks = this.toTextBlocks(m.content);
        if (blocks.length > 0) system = blocks;
        continue;
      }

      if (m.role === 'tool') {
        const text =
          typeof m.content === 'string'
            ? m.content
            : m.content.map((b) => b.text).join('');
        if (!m.toolCallId) {
          this.logger.warn('Tool message without toolCallId — dropping');
          continue;
        }
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: text || '(empty)',
        });
        continue;
      }

      flushToolResults();

      if (m.role === 'user') {
        const blocks = this.toTextBlocks(m.content);
        if (blocks.length === 0) continue;
        // Anthropic aceita string OU array. Pra preservar cache_control,
        // mando array sempre que houver flag de cache; senão string simples.
        const hasCache = blocks.some((b) => b.cache_control);
        out.push({
          role: 'user',
          content: hasCache ? blocks : blocks.map((b) => b.text).join(''),
        });
        continue;
      }

      if (m.role === 'assistant') {
        const text =
          typeof m.content === 'string'
            ? m.content
            : m.content.map((b) => b.text).join('');
        const contentBlocks: Array<
          Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam
        > = [];
        if (text && text.trim().length > 0) {
          contentBlocks.push({ type: 'text', text });
        }
        for (const tc of m.toolCalls ?? []) {
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        // Anthropic não aceita assistant message vazio. Pula em vez de 400.
        if (contentBlocks.length === 0) continue;
        out.push({ role: 'assistant', content: contentBlocks });
      }
    }

    flushToolResults();

    return { system, messages: out };
  }

  /**
   * Normaliza content (string OU array de LlmTextPart) em
   * `TextBlockParam[]`. Filtra blocks vazios — Anthropic 400 se mandar
   * `{type:'text', text:''}`. Propaga `cache: true` como `cache_control`.
   */
  private toTextBlocks(
    content: LlmMessage['content'],
  ): Anthropic.TextBlockParam[] {
    const raw =
      typeof content === 'string'
        ? [{ type: 'text' as const, text: content }]
        : content;
    return raw
      .filter((b) => b.text && b.text.length > 0)
      .map((b) => {
        const block: Anthropic.TextBlockParam = { type: 'text', text: b.text };
        if ('cache' in b && b.cache) {
          block.cache_control = { type: 'ephemeral' };
        }
        return block;
      });
  }

  /**
   * Filtra tools com schema obviamente quebrado antes de mandar pra API.
   * Um schema malformado (faltando `type:object`, properties não-objeto,
   * etc) faz a API inteira 400 — perdemos UMA tool é melhor que perder
   * o turno todo.
   */
  private sanitizeTools(tools: LlmToolDefinition[]): LlmToolDefinition[] {
    const valid: LlmToolDefinition[] = [];
    for (const t of tools) {
      const reason = this.validateToolSchema(t);
      if (reason) {
        this.logger.warn(
          `Dropping tool ${t.name} from LLM request: ${reason}`,
        );
        continue;
      }
      valid.push(t);
    }
    return valid;
  }

  private validateToolSchema(t: LlmToolDefinition): string | null {
    if (!t.name || typeof t.name !== 'string') return 'missing name';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name))
      return `invalid name "${t.name}" — must match [a-zA-Z0-9_-]{1,64}`;
    if (!t.description || typeof t.description !== 'string')
      return 'missing description';
    const p = t.parameters as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') return 'parameters not an object';
    if (p.type !== 'object')
      return `parameters.type must be "object", got ${JSON.stringify(p.type)}`;
    if (p.properties && typeof p.properties !== 'object')
      return 'parameters.properties must be an object';
    return null;
  }

  /**
   * Converte tools pro shape Anthropic e marca o ÚLTIMO tool como
   * cacheable. Anthropic interpreta `cache_control` em qualquer
   * tool como "cache toda a array de tools até aqui" — então marcar
   * o último basta pra cachear todas (95%+ economia em tools que
   * não mudam entre turns).
   */
  private toAnthropicTools(tools: LlmToolDefinition[]): Anthropic.ToolUnion[] {
    const result: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
    if (result.length > 0) {
      result[result.length - 1].cache_control = { type: 'ephemeral' };
    }
    return result;
  }

  /**
   * Passa adiante apenas os params que a Anthropic API aceita —
   * evita 400 por campo desconhecido em call sites genéricos.
   */
  private sanitizeModelParams(
    params: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (!params) return {};
    const allowed = new Set([
      'top_p',
      'top_k',
      'stop_sequences',
      'metadata',
      'service_tier',
      'thinking',
    ]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (allowed.has(k)) out[k] = v;
    }
    return out;
  }

  // ─── conversão: Anthropic SDK → nossos tipos ─────────────────────

  private fromAnthropicMessage(response: Anthropic.Message): LlmMessage {
    let textContent = '';
    const toolCalls: LlmToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input ?? {}) as Record<string, unknown>,
        });
      }
      // 'thinking' / 'redacted_thinking' / 'server_tool_use' / etc — ignora
    }

    return {
      role: 'assistant',
      content: textContent,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private normalizeStopReason(
    reason: Anthropic.Message['stop_reason'],
  ): LlmCompletionResponse['stopReason'] {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'tool_use':
      case 'pause_turn':
        return 'tool_calls';
      case 'max_tokens':
        return 'length';
      case 'refusal':
        return 'content_filter';
      default:
        return 'other';
    }
  }

  private extractUsage(
    usage: Anthropic.Usage,
    modelId: string,
  ): LlmUsage {
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd: this.calculateCost(modelId, {
        input,
        output,
        cacheRead,
        cacheWrite,
      }),
    };
  }

  /**
   * Calcula custo USD client-side — Anthropic não retorna `cost` no
   * response. Tabela de preços por modelo + cache read/write próprios.
   */
  private calculateCost(
    modelId: string,
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    },
  ): number {
    const p =
      MODEL_PRICING_USD_PER_MTOK[modelId] ??
      MODEL_PRICING_USD_PER_MTOK.default;
    return (
      (tokens.input * p.input +
        tokens.output * p.output +
        tokens.cacheRead * p.cacheRead +
        tokens.cacheWrite * p.cacheWrite) /
      1_000_000
    );
  }

  // ─── error handling ──────────────────────────────────────────────

  private handleAnthropicError(
    err: unknown,
    modelId: string,
    tools: Anthropic.ToolUnion[] | undefined,
    messages: Anthropic.MessageParam[],
    system: Anthropic.TextBlockParam[] | undefined,
  ): void {
    const status =
      err instanceof Anthropic.APIError ? err.status : undefined;
    const message = this.errorMessage(err);
    const toolNames = tools?.map((t) => (t as Anthropic.Tool).name).join(',');
    this.logger.error(
      `LLM call failed [${modelId}] status=${status ?? '?'}: ${message} | tools=[${toolNames ?? ''}]`,
    );
    if (err instanceof Anthropic.BadRequestError) {
      // 400 — dump prompt sample + tools pra ajudar a debugar
      this.logger.debug(`Messages count: ${messages.length}`);
      if (system && system.length > 0) {
        const sample = system[0].text.slice(0, 600);
        this.logger.debug(`System sample: ${sample}...`);
      }
      if (tools) {
        this.logger.debug(
          `Tools dump: ${safeStringify(tools).slice(0, 4000)}`,
        );
      }
    }
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Anthropic.APIError) {
      return `${err.name}(${err.status}): ${err.message}`;
    }
    if (err instanceof Error) return err.message;
    return String(err);
  }
}

/**
 * Tabela de preços (USD por 1M tokens) por modelo. Espelha a tabela
 * pública da Anthropic em platform.claude.com/docs/en/pricing.
 */
const MODEL_PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-7':   { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6':   { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-haiku-4-5':  { input: 1, output: 5,  cacheRead: 0.1, cacheWrite: 1.25 },
  // Fallback conservador (assume Sonnet) pra IDs desconhecidos.
  default: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

function safeStringify(input: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(input, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
  } catch (err) {
    return `[unstringifyable: ${(err as Error)?.message}]`;
  }
}
