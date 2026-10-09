-- Existing grants remain explicit: their original provenance cannot be inferred safely.
ALTER TABLE "channel_agents" ADD COLUMN "is_manual" BOOLEAN NOT NULL DEFAULT true;

ALTER TYPE "AiPendingActionStatus" ADD VALUE IF NOT EXISTS 'EXECUTING';
