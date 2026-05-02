/*
  Warnings:

  - Made the column `source` on table `ai_skill_versions` required. This step will fail if there are existing NULL values in that column.
  - Made the column `parameters` on table `ai_skill_versions` required. This step will fail if there are existing NULL values in that column.
  - Made the column `sql_read_only` on table `ai_skill_versions` required. This step will fail if there are existing NULL values in that column.
  - Made the column `sql_max_rows` on table `ai_skill_versions` required. This step will fail if there are existing NULL values in that column.
  - Made the column `timeout_ms` on table `ai_skill_versions` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "ai_skills" DROP CONSTRAINT "ai_skills_tool_id_fkey";

-- AlterTable
ALTER TABLE "ai_agents" ADD COLUMN     "follow_up_cadence_hours" INTEGER[] DEFAULT ARRAY[4, 24, 72, 168, 336]::INTEGER[],
ADD COLUMN     "follow_up_enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ai_skill_versions" ALTER COLUMN "source" SET NOT NULL,
ALTER COLUMN "parameters" SET NOT NULL,
ALTER COLUMN "sql_read_only" SET NOT NULL,
ALTER COLUMN "sql_max_rows" SET NOT NULL,
ALTER COLUMN "timeout_ms" SET NOT NULL;

-- CreateTable
CREATE TABLE "inbox_views" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "color" TEXT,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbox_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inbox_views_user_id_order_idx" ON "inbox_views"("user_id", "order");

-- CreateIndex
CREATE INDEX "inbox_views_organization_id_user_id_idx" ON "inbox_views"("organization_id", "user_id");

-- AddForeignKey
ALTER TABLE "ai_skills" ADD CONSTRAINT "ai_skills_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "ai_tools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_views" ADD CONSTRAINT "inbox_views_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_views" ADD CONSTRAINT "inbox_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
