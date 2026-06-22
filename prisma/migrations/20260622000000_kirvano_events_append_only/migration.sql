-- Log append-only de webhooks Kirvano: registra TODA entrega (inclusive
-- retries/duplicadas). Tira o índice único (event, sale_id) que descartava
-- a 2ª entrega — a idempotência de AÇÃO passa a ser garantida no processor
-- (concurrency 1) + nos guards de card. Adiciona o status DUPLICATE.

-- DropIndex
DROP INDEX IF EXISTS "uq_kirvano_event_sale";

-- CreateIndex
CREATE INDEX "idx_kirvano_event_sale" ON "kirvano_events"("event", "sale_id");

-- AlterEnum
ALTER TYPE "KirvanoEventStatus" ADD VALUE IF NOT EXISTS 'DUPLICATE';
