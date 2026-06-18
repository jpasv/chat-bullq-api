-- Projects: cada grupo de WhatsApp tratado como um Projeto perene.
-- Keyed por (organization_id, group_jid) — o JID é o invariante do grupo.
-- Tudo aditivo (tabela + índices novos) — sem mudança destrutiva.

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "group_jid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hoppe_id" TEXT,
    "responsible_user_id" TEXT,
    "status" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_organization_id_group_jid_key" ON "projects"("organization_id", "group_jid");

-- CreateIndex
CREATE INDEX "idx_project_org_hoppe" ON "projects"("organization_id", "hoppe_id");

-- CreateIndex
CREATE INDEX "idx_project_org_responsible" ON "projects"("organization_id", "responsible_user_id");

-- CreateIndex
CREATE INDEX "idx_project_org_status" ON "projects"("organization_id", "status");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_responsible_user_id_fkey" FOREIGN KEY ("responsible_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
