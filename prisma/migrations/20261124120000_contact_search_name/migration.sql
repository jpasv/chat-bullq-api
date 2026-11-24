-- Busca de conversas/contatos ignorando maiúscula, acento e espaço sobrando
-- ("joao" acha "João"). O nome normalizado fica numa coluna mantida por
-- trigger, e a API normaliza o termo do mesmo jeito
-- (src/common/search/normalize-search.ts) antes do LIKE. Índices trigram
-- deixam o LIKE '%termo%' rápido (sem eles a busca varria contacts inteira).
--
-- Idempotente: no Postgres da Bravy (200 mil+ contatos) a coluna, o
-- backfill em lotes e os índices CONCURRENTLY foram aplicados à mão antes
-- do deploy — fazer aqui seguraria um lock exclusivo em contacts durante o
-- backfill inteiro. Num banco onde ainda não existe, faz tudo.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION chat_normalize_search(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
    translate(
      regexp_replace(normalize(lower(value), NFD), '[̀-ͯ]', '', 'g'),
      'øđłħŧıð', 'odlhtid'
    ),
    '\s+', ' ', 'g'
  ))
$$;

CREATE OR REPLACE FUNCTION contacts_set_search_name() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_name := chat_normalize_search(NEW.name);
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'contacts' AND column_name = 'search_name'
  ) THEN
    ALTER TABLE "contacts" ADD COLUMN "search_name" TEXT;
    UPDATE "contacts" SET "search_name" = chat_normalize_search("name") WHERE "name" IS NOT NULL;
  END IF;
END
$$;

-- Também em UPDATE OF search_name: quem tentar gravar a coluna à mão é
-- sobrescrito, ela sempre reflete o name. Só cria se não existir (recriar
-- pegaria lock exclusivo em contacts à toa).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_contacts_search_name' AND tgrelid = '"contacts"'::regclass
  ) THEN
    CREATE TRIGGER trg_contacts_search_name
    BEFORE INSERT OR UPDATE OF "name", "search_name" ON "contacts"
    FOR EACH ROW EXECUTE FUNCTION contacts_set_search_name();
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "idx_contact_search_name_trgm" ON "contacts" USING GIN ("search_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_contact_phone_trgm" ON "contacts" USING GIN ("phone" gin_trgm_ops);
