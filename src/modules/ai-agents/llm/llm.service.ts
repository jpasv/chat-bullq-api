import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmMessage,
  LlmToolDefinition,
  LlmUsage,
} from './llm.types';

/**
 * Talks to any LLM via OpenRouter's OpenAI-compatible API. Adds Anthropic
 * prompt-caching markers when the target model is `anthropic/*`.
 *
 * One service for every provider — the codebase only depends on this.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly client: OpenAI;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('OPENROUTER_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'OPENROUTER_API_KEY not set — AI agents will fail at runtime',
      );
    }
    this.client = new OpenAI({
      apiKey: apiKey ?? 'missing',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        // OpenRouter uses these for analytics + leaderboard attribution.
        'HTTP-Referer': config.get<string>('APP_URL') ?? 'https://chat-bullq.dev',
        'X-Title': 'Chat BullQ',
      },
    });
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const isAnthropic = req.modelId.startsWith('anthropic/');
    const messages = this.toOpenAiMessages(req.messages, isAnthropic);
    const tools = req.tools
      ? this.toOpenAiTools(this.sanitizeTools(req.tools), isAnthropic)
      : undefined;

    let response: any;
    try {
      response = await this.client.chat.completions.create({
        model: req.modelId,
        messages,
        tools,
        temperature: req.temperature ?? 0.7,
        max_tokens: req.maxTokens ?? 2048,
        stream: false,
        ...(req.modelParams ?? {}),
        // OpenRouter returns cost when this is set.
        usage: { include: true },
      } as any);
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const detail = extractProviderErrorDetail(err);
      const toolNames = tools?.map((t: any) => t.function?.name).join(',');
      this.logger.error(
        `LLM call failed [${req.modelId}] status=${status ?? '?'}: ${detail} | tools=[${toolNames ?? ''}]`,
      );
      // Verbose dump on 400: the `detail` string usually says nothing
      // ("Provider returned error") because OpenRouter wraps the upstream
      // body. Walk every nested error/body shape we've seen so the next
      // failure leaves a clear trail in the logs.
      if (status === 400) {
        const errorShape = {
          name: err?.name,
          message: err?.message,
          status: err?.status,
          headers: err?.headers,
          error: err?.error,
          responseData: err?.response?.data,
          body: err?.body,
          cause: err?.cause,
        };
        this.logger.error(
          `LLM 400 raw err: ${safeStringify(errorShape).slice(0, 4000)}`,
        );
        if (tools) {
          this.logger.debug(
            `Tools dump: ${safeStringify(tools).slice(0, 4000)}`,
          );
        }
        // Sample of the system message (first 600 chars) — useful when 400
        // is caused by something specific in the prompt.
        const sysMsg = messages.find((m: any) => m.role === 'system');
        if (sysMsg) {
          const sysContent =
            typeof sysMsg.content === 'string'
              ? sysMsg.content
              : Array.isArray(sysMsg.content)
                ? (sysMsg.content as any[])
                    .map((p) => p?.text ?? '')
                    .join('')
                : '';
          this.logger.debug(
            `System sample: ${sysContent.slice(0, 600)}...`,
          );
        }
      }
      throw new InternalServerErrorException(
        `LLM provider error (${status ?? 'no-status'}): ${detail}`,
      );
    }

    const choice = response.choices?.[0];
    if (!choice) {
      throw new InternalServerErrorException('LLM returned no choices');
    }

    const message = this.fromOpenAiMessage(choice.message);
    const stopReason = this.normalizeStopReason(choice.finish_reason);
    const usage = this.extractUsage(response);

    return {
      message,
      stopReason,
      usage,
      rawModelId: response.model ?? req.modelId,
    };
  }

  // ─── conversion: our types → OpenAI SDK ──────────────────────────

  private toOpenAiMessages(
    messages: LlmMessage[],
    enableCache: boolean,
  ): ChatCompletionMessageParam[] {
    return messages.map((m): ChatCompletionMessageParam => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.toolCallId!,
          content:
            typeof m.content === 'string'
              ? m.content
              : m.content.map((p) => p.text).join(''),
        };
      }
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content:
            typeof m.content === 'string'
              ? m.content
              : m.content.map((p) => p.text).join(''),
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                  },
                })),
              }
            : {}),
        };
      }

      // role: 'system' | 'user' — the only ones where caching applies
      const blocks =
        typeof m.content === 'string'
          ? [{ type: 'text' as const, text: m.content, cache: false }]
          : m.content;

      const content = blocks.map((b) => {
        const part: Record<string, unknown> = { type: 'text', text: b.text };
        if (enableCache && b.cache) {
          // OpenRouter passes cache_control to Anthropic models.
          part.cache_control = { type: 'ephemeral' };
        }
        return part;
      });

      return {
        role: m.role as 'system' | 'user',
        content: content as unknown as ChatCompletionMessageParam['content'],
      } as ChatCompletionMessageParam;
    });
  }

  /**
   * Drops tools with obviously broken JSON Schema before they reach the
   * provider. A single malformed schema (missing `type: object`, params not
   * being an object, properties with empty type) makes the whole request
   * 400 — and the agent can't recover from that. Better to lose one tool
   * than the entire turn.
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

  private toOpenAiTools(
    tools: LlmToolDefinition[],
    enableCache: boolean,
  ): ChatCompletionTool[] {
    const result: ChatCompletionTool[] = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    // Mark the tools array as cacheable for Anthropic — the schemas are
    // stable so this saves ~95% of the tool-token cost on every call.
    if (enableCache && result.length > 0) {
      // Hack: we attach cache_control to the last tool. OpenRouter forwards
      // it to Anthropic, which interprets it as "cache everything up to here".
      (result[result.length - 1] as unknown as { cache_control: unknown }).cache_control = {
        type: 'ephemeral',
      };
    }

    return result;
  }

  // ─── conversion: OpenAI SDK → our types ──────────────────────────

  private fromOpenAiMessage(msg: any): LlmMessage {
    const toolCalls = msg.tool_calls?.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: this.safeParseJson(tc.function?.arguments),
    }));

    return {
      role: 'assistant',
      content: msg.content ?? '',
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private normalizeStopReason(
    reason?: string | null,
  ): LlmCompletionResponse['stopReason'] {
    switch (reason) {
      case 'stop':
      case 'end_turn':
        return 'stop';
      case 'tool_calls':
      case 'tool_use':
        return 'tool_calls';
      case 'length':
      case 'max_tokens':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'other';
    }
  }

  private extractUsage(response: any): LlmUsage {
    const u = response.usage ?? {};
    const promptTokensDetails = u.prompt_tokens_details ?? {};
    return {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      cacheReadTokens: promptTokensDetails.cached_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      // OpenRouter only returns `cost` when usage.include=true is set.
      costUsd: typeof u.cost === 'number' ? u.cost : 0,
    };
  }

  private safeParseJson(raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== 'string') return {};
    try {
      return JSON.parse(raw);
    } catch {
      this.logger.warn(`Tool call had unparseable arguments: ${raw}`);
      return {};
    }
  }
}

/**
 * OpenRouter wraps upstream provider errors in a generic envelope:
 *   { error: { code, message: "Provider returned error",
 *              metadata: { raw, provider_name } } }
 *
 * The actual reason from Anthropic/OpenAI/etc lives in `metadata.raw`
 * as a JSON string (sometimes a plain string). We dig through every
 * shape we've seen and prefer the most specific message available.
 *
 * Returns a single human-readable line — what the agent run UI shows
 * to the operator and what the backend logs to error logs.
 */
function extractProviderErrorDetail(err: any): string {
  const candidates: string[] = [];

  // 1. OpenRouter envelope, accessible from multiple paths depending on
  //    SDK version.
  const envelopes = [
    err?.error,
    err?.error?.error,
    err?.body?.error,
    err?.response?.data?.error,
    err?.response?.data,
  ].filter(Boolean);

  for (const e of envelopes) {
    // metadata.raw — actual upstream body (often JSON string).
    const raw = e?.metadata?.raw ?? e?.metadata?.body;
    if (typeof raw === 'string' && raw.length > 0) {
      const parsed = tryParseJson(raw);
      if (parsed) {
        const m =
          parsed?.error?.message ??
          parsed?.error?.error?.message ??
          parsed?.message;
        const t = parsed?.error?.type ?? parsed?.type;
        if (typeof m === 'string' && m.length > 0) {
          candidates.push(t ? `${t}: ${m}` : m);
        }
      } else {
        // Not JSON — provider returned plain text. Trim the noise.
        candidates.push(raw.slice(0, 500));
      }
    }
    // Fallback to envelope-level fields, but skip the generic OpenRouter
    // string when we already have a more specific one.
    if (typeof e?.message === 'string' && e.message !== 'Provider returned error') {
      candidates.push(e.message);
    }
  }

  // 2. SDK-level fallbacks.
  if (typeof err?.message === 'string' && err.message !== 'Provider returned error') {
    candidates.push(err.message);
  }

  // First non-empty wins. If everything else is empty, we still want to
  // surface SOMETHING — fall back to the generic line so the run isn't
  // labelled "unknown".
  const detail = candidates.find((c) => c && c.trim().length > 0);
  return detail ?? err?.error?.message ?? err?.message ?? 'unknown';
}

function tryParseJson(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Stringify with circular-ref protection. Provider error objects often
 * carry circular `request`/`response` pointers from the OpenAI SDK that
 * crash a naive JSON.stringify.
 */
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
