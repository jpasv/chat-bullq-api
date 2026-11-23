-- Índice da listagem da inbox: `findInbox` ordena por
-- `last_message_at DESC NULLS LAST` dentro da organização. O índice simples
-- `idx_conv_last_msg` (ASC, NULLS LAST) não atende essa ordenação, então cada
-- carregamento varria e ordenava todas as conversas da organização.
-- Índice parcial só em SQL (o Prisma não descreve índice parcial no schema),
-- mesmo padrão de `idx_conv_watchdog_scan`.
CREATE INDEX IF NOT EXISTS "idx_conv_inbox_recent"
  ON "conversations" ("organization_id", "last_message_at" DESC NULLS LAST)
  WHERE "deleted_at" IS NULL;
