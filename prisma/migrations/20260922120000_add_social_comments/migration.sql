-- CreateEnum
CREATE TYPE "SocialCommentStatus" AS ENUM ('VISIBLE', 'HIDDEN', 'DELETED');

-- CreateTable
CREATE TABLE "social_comments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "parent_external_id" TEXT,
    "media_id" TEXT NOT NULL,
    "media_permalink" TEXT,
    "media_caption" TEXT,
    "media_thumbnail_url" TEXT,
    "author_external_id" TEXT NOT NULL,
    "author_username" TEXT,
    "text" TEXT NOT NULL,
    "status" "SocialCommentStatus" NOT NULL DEFAULT 'VISIBLE',
    "is_from_page" BOOLEAN NOT NULL DEFAULT false,
    "replied_at" TIMESTAMP(3),
    "replied_by_id" TEXT,
    "private_reply_conversation_id" TEXT,
    "commented_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_comments_channel_id_external_id_key" ON "social_comments"("channel_id", "external_id");
CREATE INDEX "idx_social_comment_org_time" ON "social_comments"("organization_id", "commented_at");
CREATE INDEX "idx_social_comment_media" ON "social_comments"("channel_id", "media_id");
CREATE INDEX "idx_social_comment_thread" ON "social_comments"("channel_id", "parent_external_id");

-- AddForeignKey
ALTER TABLE "social_comments" ADD CONSTRAINT "social_comments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_comments" ADD CONSTRAINT "social_comments_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
