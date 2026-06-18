-- Segmentos: grupos compartilhados entre vários canais.
-- Tudo aditivo (colunas nullable / tabelas / índices novos) — sem mudança destrutiva.

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "segment_id" TEXT;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "provider_timestamp" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primary_channel_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segment_channels" (
    "id" TEXT NOT NULL,
    "segment_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "segment_channels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_segment_org" ON "segments"("organization_id");

-- CreateIndex
CREATE INDEX "idx_segment_channel_channel" ON "segment_channels"("channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "segment_channels_segment_id_channel_id_key" ON "segment_channels"("segment_id", "channel_id");

-- CreateIndex
CREATE INDEX "idx_conv_segment_contact" ON "conversations"("segment_id", "contact_id");

-- CreateIndex
CREATE INDEX "idx_msg_conv_provider_ts" ON "messages"("conversation_id", "provider_timestamp");

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_primary_channel_id_fkey" FOREIGN KEY ("primary_channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segment_channels" ADD CONSTRAINT "segment_channels_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segment_channels" ADD CONSTRAINT "segment_channels_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
