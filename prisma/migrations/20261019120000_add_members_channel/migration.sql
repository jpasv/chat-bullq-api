-- Área de membros (members-backend) como tipo de canal. Conversa chaveada
-- por external_thread_id (= support_conversations.id do members-backend).

-- AlterEnum
ALTER TYPE "ChannelType" ADD VALUE 'MEMBERS';
