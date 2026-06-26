/**
 * Tipos LLM normalizados — desacoplam o resto do codebase do SDK.
 * Todos os agents falam com o provider LLM via LlmService.
 */

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmTextPart {
  type: 'text';
  text: string;
  /** When true, this block is stable and may be cacheable by providers that support prompt caching. */
  cache?: boolean;
}

/**
 * Image input block. O provider aceita tanto URL pública quanto base64 quando houver suporte a vision.
 * URL é o caminho preferido — o provider baixa os bytes do lado dele uma
 * vez por request. Base64 só quando a URL não é pública (raro hoje, todos
 * os 3 canais resolvem mídia pra URL pública via media-resolver).
 */
export interface LlmImagePart {
  type: 'image';
  /** URL pública (HTTPS) playable. Caso default. */
  url?: string;
  /** Fallback base64. `data` sem prefixo `data:image/...;base64,`. */
  base64?: { mediaType: string; data: string };
}

export type LlmContentPart = LlmTextPart | LlmImagePart;
export type LlmContent = string | LlmContentPart[];

export interface LlmMessage {
  role: LlmRole;
  content: LlmContent;
  /** Present on assistant messages that called tools. */
  toolCalls?: LlmToolCall[];
  /** Present on tool messages — id of the assistant tool call this responds to. */
  toolCallId?: string;
  /** Present on tool messages — name of the tool that ran. */
  name?: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
}

export interface LlmCompletionRequest {
  modelId: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Overrides do provedor (top_p, top_k, stop_sequences, thinking, etc). */
  modelParams?: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface LlmCompletionResponse {
  /** Final assistant message, possibly with tool calls. */
  message: LlmMessage;
  /** 'stop' = done. 'tool_calls' = caller must run tools and continue. */
  stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';
  usage: LlmUsage;
  rawModelId: string;
}
