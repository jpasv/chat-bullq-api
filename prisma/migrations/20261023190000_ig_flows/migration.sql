-- Fluxos do Instagram (comentário/story → DM com botões, condição, webhook, atraso)
CREATE TABLE "ig_flows" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "channel_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trigger_type" TEXT NOT NULL,
    "trigger_config" JSONB NOT NULL DEFAULT '{}',
    "nodes" JSONB NOT NULL DEFAULT '[]',
    "start_node_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "ig_flows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "idx_ig_flow_org_active" ON "ig_flows"("organization_id", "is_active");

CREATE TABLE "ig_flow_runs" (
    "id" TEXT NOT NULL,
    "flow_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "contact_external_id" TEXT NOT NULL,
    "contact_username" TEXT,
    "comment_external_id" TEXT,
    "media_id" TEXT,
    "trigger_text" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "current_node_id" TEXT,
    "private_reply_used" BOOLEAN NOT NULL DEFAULT false,
    "last_interaction_at" TIMESTAMP(3),
    "log" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ig_flow_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ig_flow_runs_flow_id_comment_external_id_key" ON "ig_flow_runs"("flow_id", "comment_external_id");
CREATE INDEX "idx_ig_flow_run_contact" ON "ig_flow_runs"("channel_id", "contact_external_id");
ALTER TABLE "ig_flow_runs" ADD CONSTRAINT "ig_flow_runs_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "ig_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
