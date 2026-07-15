-- Gmail como novo tipo de canal (polling) + conversa por thread de email.

-- AlterEnum
ALTER TYPE "ChannelType" ADD VALUE 'GMAIL';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "external_thread_id" TEXT;

-- CreateIndex
-- NULLs são distintos no Postgres → canais de chat (thread NULL) não colidem.
CREATE UNIQUE INDEX "uq_conv_channel_thread" ON "conversations"("channel_id", "external_thread_id");
