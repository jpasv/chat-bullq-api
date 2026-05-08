/**
 * Tipos LLM normalizados — desacoplam o resto do codebase do SDK.
 * Hoje todos os agents falam com a Anthropic API direto via LlmService.
 */

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmTextPart {
  type: 'text';
  text: string;
  /** When true, this block is marked as cacheable for Anthropic models. */
  cache?: boolean;
}

export type LlmContent = string | LlmTextPart[];

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
