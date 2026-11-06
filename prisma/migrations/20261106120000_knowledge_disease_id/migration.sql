-- Stabilise the disease key used for exact RAG grounding.
--
-- The existing chunk_id (CHUNK_RICE_BLAST_000) contains the disease key but is
-- not a queryable disease identifier. Retrieval must be able to filter to the
-- diagnosed disease before ranking by vector similarity, otherwise a rice-blast
-- diagnosis can receive a brown-spot protocol.
ALTER TABLE "knowledge_chunks"
  ADD COLUMN IF NOT EXISTS "disease_id" VARCHAR(80);

-- Backfill the existing rows from their chunk id so the migration is useful
-- even before `seed:knowledge` is re-run.
UPDATE "knowledge_chunks"
SET "disease_id" = substring("chunk_id" from '^CHUNK_(.*)_[0-9]{3}$')
WHERE "disease_id" IS NULL
  AND "chunk_id" ~ '^CHUNK_.*_[0-9]{3}$';

CREATE INDEX IF NOT EXISTS "knowledge_chunks_disease_id_idx"
  ON "knowledge_chunks"("disease_id");
