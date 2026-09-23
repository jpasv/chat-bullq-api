CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ai_vector_entries (
  id              text PRIMARY KEY,
  owner_type      text NOT NULL,           -- 'message' | 'fact' | 'memory_summary'
  owner_id        text NOT NULL,           -- FK in the source domain
  conversation_id text,
  agent_id        text,
  contact_id      text,
  content         text NOT NULL,           -- original text (returned at search time)
  embedding       vector(1536) NOT NULL,   -- text-embedding-3-small dims
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Filter indexes for the scope predicates.
CREATE INDEX IF NOT EXISTS ai_vector_entries_owner_idx        ON ai_vector_entries(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS ai_vector_entries_conversation_idx ON ai_vector_entries(conversation_id);
CREATE INDEX IF NOT EXISTS ai_vector_entries_agent_idx        ON ai_vector_entries(agent_id);
CREATE INDEX IF NOT EXISTS ai_vector_entries_contact_idx      ON ai_vector_entries(contact_id);

-- Approximate nearest neighbour index for cosine distance.
-- `lists = 100` is fine for tens of thousands of rows; tune up for >1M.
CREATE INDEX IF NOT EXISTS ai_vector_entries_embedding_idx
  ON ai_vector_entries
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
