-- Recuperação de Vendas: pipeline movido por webhooks da Kirvano + IA.
-- Tudo aditivo (colunas opcionais + tabela/enum novos) — sem mudança destrutiva.

-- Chave semântica estável pra integrações automáticas mirarem o pipeline/stage
-- sem depender do nome (editável na UI).
-- AlterTable
ALTER TABLE "pipelines" ADD COLUMN "key" TEXT;

-- AlterTable
ALTER TABLE "pipeline_stages" ADD COLUMN "key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "uq_pipeline_org_key" ON "pipelines"("organization_id", "key");

-- CreateEnum
CREATE TYPE "KirvanoEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateTable
CREATE TABLE "kirvano_events" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "product_uuid" TEXT,
    "sale_id" TEXT,
    "checkout_id" TEXT,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "status" "KirvanoEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "organization_id" TEXT,
    "error_message" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    CONSTRAINT "kirvano_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_kirvano_event_sale" ON "kirvano_events"("event", "sale_id");

-- CreateIndex
CREATE INDEX "idx_kirvano_event_checkout" ON "kirvano_events"("event", "checkout_id");

-- CreateIndex
CREATE INDEX "idx_kirvano_status_time" ON "kirvano_events"("status", "received_at" DESC);
