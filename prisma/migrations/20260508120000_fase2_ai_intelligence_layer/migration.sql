-- ============================================================================
-- Fase 2 — AI Intelligence Layer (parte 1: SEM pgvector)
-- ============================================================================
-- Adiciona infra pra:
--   1. Prompt Composer 4 layers (org.ai_security_rules)
--   2. Intent Classifier (org.ai_classifier_threshold + ai_agent_runs.classified_*)
--   3. Confirmação destrutiva (ai_pending_actions)
--
-- A parte do RAG (pgvector + ai_vector_entries) está em migration separada
-- (20260508120100_pgvector_rag) porque exige o package pgvector instalado
-- no Postgres — não disponível em todos os ambientes managed.
-- ============================================================================

-- 1. Organization: regras de segurança e threshold do classifier
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "ai_security_rules" JSONB,
  ADD COLUMN IF NOT EXISTS "ai_classifier_threshold" DECIMAL(3, 2) DEFAULT 0.85;

-- 2. AiAgentRun: campos do classifier
ALTER TABLE "ai_agent_runs"
  ADD COLUMN IF NOT EXISTS "classified_intent" TEXT,
  ADD COLUMN IF NOT EXISTS "classifier_confidence" DECIMAL(4, 3),
  ADD COLUMN IF NOT EXISTS "skipped_orchestrator" BOOLEAN NOT NULL DEFAULT false;

-- 3. Enums pro PendingAction
DO $$ BEGIN
  CREATE TYPE "AiPendingActionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "AiPendingActionImpact" AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 4. Tabela ai_pending_actions
CREATE TABLE IF NOT EXISTS "ai_pending_actions" (
  "id"               TEXT NOT NULL,
  "agent_run_id"     TEXT NOT NULL,
  "conversation_id"  TEXT NOT NULL,
  "agent_id"         TEXT NOT NULL,
  "tool_name"        TEXT NOT NULL,
  "args"             JSONB NOT NULL,
  "preview"          JSONB NOT NULL,
  "status"           "AiPendingActionStatus" NOT NULL DEFAULT 'PENDING',
  "expires_at"       TIMESTAMP(3) NOT NULL,
  "approved_by"      TEXT,
  "approved_at"      TIMESTAMP(3),
  "rejected_by"      TEXT,
  "rejected_at"      TIMESTAMP(3),
  "rejected_reason"  TEXT,
  "execution_result" JSONB,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_pending_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_ai_pending_conv_status" ON "ai_pending_actions"("conversation_id", "status");
CREATE INDEX IF NOT EXISTS "idx_ai_pending_status_exp"  ON "ai_pending_actions"("status", "expires_at");
CREATE INDEX IF NOT EXISTS "idx_ai_pending_run"         ON "ai_pending_actions"("agent_run_id");

DO $$ BEGIN
  ALTER TABLE "ai_pending_actions"
    ADD CONSTRAINT "ai_pending_actions_agent_run_id_fkey"
    FOREIGN KEY ("agent_run_id") REFERENCES "ai_agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_pending_actions"
    ADD CONSTRAINT "ai_pending_actions_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_pending_actions"
    ADD CONSTRAINT "ai_pending_actions_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
