-- CreateTable
CREATE TABLE "onboarding_leads" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "hoppe_task_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "conversation_id" TEXT,
    "phone" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "next_action_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "attempt_dates" JSONB NOT NULL DEFAULT '[]',
    "replied_at" TIMESTAMP(3),
    "last_inbound_at" TIMESTAMP(3),
    "summary_due_at" TIMESTAMP(3),
    "last_summary_at" TIMESTAMP(3),
    "pending_reason" TEXT,
    "pending_detail" TEXT,
    "resume_sent_at" TIMESTAMP(3),
    "meeting_event_id" TEXT,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_leads_hoppe_task_id_key" ON "onboarding_leads"("hoppe_task_id");

-- CreateIndex
CREATE INDEX "idx_onboarding_state_next" ON "onboarding_leads"("state", "next_action_at");

-- CreateIndex
CREATE INDEX "idx_onboarding_state_summary" ON "onboarding_leads"("state", "summary_due_at");

-- CreateIndex
CREATE INDEX "idx_onboarding_conversation" ON "onboarding_leads"("conversation_id");
