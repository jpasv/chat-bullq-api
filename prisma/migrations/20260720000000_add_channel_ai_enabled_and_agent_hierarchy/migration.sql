-- Colunas que já existem no schema.prisma (Channel.aiEnabled e a hierarquia
-- matricial do AiAgent: parent/department/squad + contexto operacional) mas que
-- nunca tiveram migration correspondente: na base original elas foram aplicadas
-- via `prisma db push`/manual. Sem esta migration, toda base nova criada só por
-- `prisma migrate deploy` sobe SEM essas colunas e o Prisma Client quebra com
-- 500 (ex: `column channels.ai_enabled does not exist` em GET/POST /channels).
--
-- DDL idempotente (IF NOT EXISTS / guard) de propósito: precisa ser seguro tanto
-- em bases novas (cria as colunas) quanto em bases que já receberam as colunas
-- via db push (no-op), pra não falhar o deploy dessas.

-- Channel: override tri-state de IA por canal (null=segue org, true=ON, false=OFF)
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "ai_enabled" BOOLEAN;

-- AiAgent: organograma matricial (chefia/setor/squad) + contexto operacional vivo
ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "parent_agent_id" TEXT;
ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "department" TEXT;
ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "squad" TEXT;
ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "operational_context" TEXT;
ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "operational_context_updated_at" TIMESTAMP(3);

-- Índices dos novos campos (batem com @@index idx_ai_agent_parent / idx_ai_agent_org_dept)
CREATE INDEX IF NOT EXISTS "idx_ai_agent_parent" ON "ai_agents"("parent_agent_id");
CREATE INDEX IF NOT EXISTS "idx_ai_agent_org_dept" ON "ai_agents"("organization_id", "department");

-- Self-FK da hierarquia (relation "AgentHierarchy", onDelete: SetNull)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_parent_agent_id_fkey'
  ) THEN
    ALTER TABLE "ai_agents"
      ADD CONSTRAINT "ai_agents_parent_agent_id_fkey"
      FOREIGN KEY ("parent_agent_id") REFERENCES "ai_agents"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
