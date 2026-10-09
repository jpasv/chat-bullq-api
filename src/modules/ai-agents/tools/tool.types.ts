import { LlmToolDefinition } from '../llm/llm.types';

/**
 * Context passed to every tool execution. Carries everything a tool might
 * need to mutate the system on behalf of the agent.
 */
export interface ToolContext {
  /** Stable approval key, also available to SQL parameter mappings. */
  idempotencyKey?: string;
  chainDepth?: number;
  /** Chamada originada de uma menção no prompt: destino/ids já validados na compilação. */
  viaMention?: boolean;
  alreadyReplied?: boolean;
  skillBindings?: { skillId: string; requiresApproval: boolean }[];
  organizationId: string;
  conversationId: string;
  contactId: string;
  channelId: string;
  agentId: string;
  /** ID of the AiAgentRun this tool is part of (for audit logging). */
  runId: string;
  /** ID of the inbound message that triggered the run. */
  triggerMessageId?: string;
}

export interface ToolResult {
  /** Whatever the LLM should see as the tool output (will be JSON-stringified). */
  output: unknown;
  /** Side-effect signal that the runner uses to short-circuit the loop. */
  finalAction?:
    | 'REPLIED'
    | 'TRANSFERRED_TO_HUMAN'
    | 'CLOSED_CONVERSATION'
    | 'DELEGATED'
    | 'HANDED_BACK';
}

export interface AiTool {
  /** Stable identifier — must match the function name sent to the LLM. */
  name: string;
  /** What this tool does, written for the LLM. */
  description: string;
  /** JSON Schema for the input. */
  parameters: Record<string, unknown>;
  /** Run the tool. Throws on validation/permission errors. */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type ToolDefinition = Pick<AiTool, 'name' | 'description' | 'parameters'>;

export function toLlmDefinition(tool: ToolDefinition): LlmToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
