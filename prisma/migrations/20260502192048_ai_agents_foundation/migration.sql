-- CreateEnum
CREATE TYPE "AiAgentKind" AS ENUM ('ORCHESTRATOR', 'WORKER');

-- CreateEnum
CREATE TYPE "AiAgentMode" AS ENUM ('AUTONOMOUS', 'COPILOT', 'DISABLED');

-- CreateEnum
CREATE TYPE "AiAgentTrigger" AS ENUM ('ALWAYS', 'OFF_HOURS', 'NO_HUMAN_ASSIGNED');

-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AiFinalAction" AS ENUM ('REPLIED', 'DELEGATED', 'HANDED_BACK', 'TRANSFERRED_TO_HUMAN', 'CLOSED_CONVERSATION', 'NO_ACTION');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "active_agent_id" TEXT,
ADD COLUMN     "ai_disabled_at" TIMESTAMP(3),
ADD COLUMN     "ai_disabled_by" TEXT,
ADD COLUMN     "ai_enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "ai_auto_disable_on_human" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ai_business_hours" JSONB,
ADD COLUMN     "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ai_monthly_token_cap" INTEGER,
ADD COLUMN     "ai_out_of_hours_message" TEXT,
ADD COLUMN     "ai_timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo';

-- CreateTable
CREATE TABLE "ai_agents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "avatar_url" TEXT,
    "kind" "AiAgentKind" NOT NULL DEFAULT 'WORKER',
    "category" TEXT,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model_id" TEXT NOT NULL,
    "model_params" JSONB,
    "system_prompt" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "max_tokens" INTEGER NOT NULL DEFAULT 2048,
    "can_respond_directly" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_channels" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "mode" "AiAgentMode" NOT NULL DEFAULT 'AUTONOMOUS',
    "trigger" "AiAgentTrigger" NOT NULL DEFAULT 'ALWAYS',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_memories" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "summary" TEXT,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "total_interactions" INTEGER NOT NULL DEFAULT 0,
    "last_interaction_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agent_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "trigger_message_id" TEXT,
    "status" "AiRunStatus" NOT NULL DEFAULT 'RUNNING',
    "final_action" "AiFinalAction",
    "error_message" TEXT,
    "model_id" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "ai_agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tool_calls" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_handoffs" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "from_agent_id" TEXT,
    "to_agent_id" TEXT NOT NULL,
    "reason" TEXT,
    "briefing" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_ai_agent_org" ON "ai_agents"("organization_id");

-- CreateIndex
CREATE INDEX "idx_ai_agent_org_kind" ON "ai_agents"("organization_id", "kind");

-- CreateIndex
CREATE INDEX "idx_ai_agent_channel_channel" ON "ai_agent_channels"("channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_channels_agent_id_channel_id_key" ON "ai_agent_channels"("agent_id", "channel_id");

-- CreateIndex
CREATE INDEX "idx_ai_memory_agent" ON "ai_agent_memories"("agent_id");

-- CreateIndex
CREATE INDEX "idx_ai_memory_contact" ON "ai_agent_memories"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_memories_agent_id_contact_id_key" ON "ai_agent_memories"("agent_id", "contact_id");

-- CreateIndex
CREATE INDEX "idx_ai_run_org_time" ON "ai_agent_runs"("organization_id", "started_at");

-- CreateIndex
CREATE INDEX "idx_ai_run_conv" ON "ai_agent_runs"("conversation_id");

-- CreateIndex
CREATE INDEX "idx_ai_run_agent" ON "ai_agent_runs"("agent_id");

-- CreateIndex
CREATE INDEX "idx_ai_tool_call_run" ON "ai_tool_calls"("run_id");

-- CreateIndex
CREATE INDEX "idx_ai_handoff_conv" ON "ai_agent_handoffs"("conversation_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_active_agent_id_fkey" FOREIGN KEY ("active_agent_id") REFERENCES "ai_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_channels" ADD CONSTRAINT "ai_agent_channels_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_channels" ADD CONSTRAINT "ai_agent_channels_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_memories" ADD CONSTRAINT "ai_agent_memories_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_memories" ADD CONSTRAINT "ai_agent_memories_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_runs" ADD CONSTRAINT "ai_agent_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_runs" ADD CONSTRAINT "ai_agent_runs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ai_agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_handoffs" ADD CONSTRAINT "ai_agent_handoffs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_handoffs" ADD CONSTRAINT "ai_agent_handoffs_from_agent_id_fkey" FOREIGN KEY ("from_agent_id") REFERENCES "ai_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_handoffs" ADD CONSTRAINT "ai_agent_handoffs_to_agent_id_fkey" FOREIGN KEY ("to_agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
