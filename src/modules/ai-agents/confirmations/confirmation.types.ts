/**
 * Types for the AI agent destructive-action confirmation system.
 *
 * High-risk tools (e.g. `grantAccess`, `resetPassword`, `transferToHuman`)
 * should NOT execute immediately. Instead they create a `PendingAction`
 * that requires human approval before being executed.
 *
 * Phase 1 (current): types + service + controller + Redis-backed storage.
 * Phase 2: Prisma `AiPendingAction` model + actual tool integration +
 * post-approval execution queue + cron expiration sweeper.
 */

export type PendingActionStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'EXECUTING'
  | 'EXECUTED';

export type ImpactLevel = 'low' | 'medium' | 'high' | 'critical';

export type AffectedEntityType =
  | 'contact'
  | 'conversation'
  | 'agent'
  | 'order';

export interface AffectedEntity {
  type: AffectedEntityType;
  id: string;
  label?: string;
}

export interface ActionPreview {
  /** Human-readable description, e.g. "Liberar acesso de João ao curso XPTO" */
  action: string;
  impact: ImpactLevel;
  /** How to revert the action, if reversible at all. */
  rollback?: string;
  /** Affected entity, so the UI can link to it. */
  affectedEntity?: AffectedEntity;
}

export interface PendingAction {
  /** UUID v4 */
  id: string;
  /** Run that produced this pending action. */
  agentRunId: string;
  conversationId: string;
  agentId: string;
  /** Tool name, e.g. 'grantAccess'. */
  toolName: string;
  /** Original args the tool was about to execute with. */
  args: Record<string, unknown>;
  preview: ActionPreview;
  status: PendingActionStatus;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp; default = createdAt + 30 minutes. */
  expiresAt: string;
  /** User id of the approver (only set when APPROVED). */
  approvedBy?: string;
  /** ISO timestamp of approval. */
  approvedAt?: string;
  /** User id of who rejected. */
  rejectedBy?: string;
  /** ISO timestamp of rejection. */
  rejectedAt?: string;
  /** Reason supplied at rejection. */
  rejectedReason?: string;
  /** Optional execution result (filled by Phase 2 executor). */
  executionResult?: unknown;
}

export interface CreatePendingActionInput {
  agentRunId: string;
  conversationId: string;
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  preview: ActionPreview;
  /** TTL in minutes; default = 30. */
  ttlMinutes?: number;
}
