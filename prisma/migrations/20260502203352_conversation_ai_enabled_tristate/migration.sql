-- AlterTable: ai_enabled vira tri-state.
--   null  = segue regras globais (default)
--   true  = força ON (override)
--   false = força OFF (override)
ALTER TABLE "conversations" ALTER COLUMN "ai_enabled" DROP NOT NULL,
ALTER COLUMN "ai_enabled" DROP DEFAULT;

-- Conversas que nunca foram explicitamente pausadas viram "sem override" (null).
-- Conversas com ai_disabled_by/at setados ficam como force-off (false).
UPDATE "conversations"
SET "ai_enabled" = NULL
WHERE "ai_disabled_by" IS NULL AND "ai_disabled_at" IS NULL AND "ai_enabled" = true;
