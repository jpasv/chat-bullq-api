/**
 * Long-term memory types — what gets persisted in the `ai_agent_memories`
 * table per (agent, contact) pair, and the contract used by the auto-update
 * extractor + context enrichment for the prompt composer.
 */

export interface MemoryFact {
  /** Plain-text fact (1 short sentence). */
  fact: string;
  /** Optional bucket — Haiku tags facts as it extracts them. */
  category?: 'identity' | 'preference' | 'history' | 'context' | string;
  /** 0-1, defaults to 0.8 when Haiku doesn't return one. */
  confidence?: number;
  /** ISO timestamp of when this fact was extracted/added. */
  extractedAt: string;
  /** `manual` = operator-edited, `auto` = extracted by the Haiku worker. */
  source: 'manual' | 'auto';
}

/**
 * Deserialized shape of one row in `ai_agent_memories` — `facts` JSON column
 * is parsed into a typed `MemoryFact[]` so callers don't deal with raw JSON.
 */
export interface AgentMemoryRecord {
  id: string;
  agentId: string;
  contactId: string;
  summary: string | null;
  facts: MemoryFact[];
  totalInteractions: number;
  lastInteractionAt: Date | null;
}

/** Input passed to `MemoryExtractorService.extract`. */
export interface ExtractionInput {
  agentId: string;
  contactId: string;
  /** Last ~20 turns, in chronological order (oldest first). */
  recentMessages: ExtractionMessage[];
  /** Whatever is already stored — Haiku uses it to dedupe + invalidate. */
  currentMemory: AgentMemoryRecord | null;
}

export interface ExtractionMessage {
  role: 'user' | 'assistant' | 'tool' | string;
  content: string;
  createdAt: string;
}

/** Output of the Haiku extractor — what to merge back into the memory row. */
export interface ExtractionResult {
  /** Newly observed facts not present in `currentMemory`. */
  newFacts: MemoryFact[];
  /** Existing fact strings that should be removed (stale or contradicted). */
  factsToRemove: string[];
  /** New 1-paragraph summary, or null if there was nothing new to update. */
  summaryUpdate: string | null;
  /** Free-form explanation from Haiku — useful for debugging/audit. */
  reasoning: string;
  /** USD cost of the Haiku call. */
  costUsd: number;
}

/** Job payload for the BullMQ `memory-extractor` queue. */
export interface MemoryExtractorJobData {
  agentId: string;
  contactId: string;
  conversationId: string;
}

/**
 * IMPORTANT: this type will be unified with the canonical `EnrichedContext`
 * defined by Agent 3 in `prompts/types.ts` during Fase 2. For now we declare
 * it locally so the long-term module compiles independently.
 */
export interface EnrichedContext {
  contact: {
    name?: string;
    email?: string;
    phone?: string;
    tags?: string[];
  };
  channel: {
    kind: 'WHATSAPP' | 'INSTAGRAM' | 'WEB';
    name: string;
  };
  time: {
    nowIso: string;
    timezone: string;
    businessHours: boolean;
  };
  memory?: {
    summary?: string;
    /** Serialized as plain strings — the prompt composer doesn't need metadata. */
    facts?: string[];
  };
  catalog?: {
    products: {
      slug: string;
      name: string;
      tagline: string;
      category: string;
    }[];
  };
  recentMessages: {
    role: 'user' | 'assistant' | 'tool';
    content: string;
  }[];
}
