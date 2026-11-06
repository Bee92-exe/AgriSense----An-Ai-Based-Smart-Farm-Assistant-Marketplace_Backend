-- pgvector-backed knowledge retrieval and diagnosis idempotency/safety.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "Diagnosis" ADD COLUMN IF NOT EXISTS "clientUuid" UUID;
CREATE UNIQUE INDEX IF NOT EXISTS "Diagnosis_clientUuid_key" ON "Diagnosis"("clientUuid");
CREATE INDEX IF NOT EXISTS "Diagnosis_status_idx" ON "Diagnosis"("status");

CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "chunk_id" VARCHAR(100) NOT NULL,
    "crop" VARCHAR(80) NOT NULL,
    "disease" VARCHAR(160) NOT NULL,
    "disease_bn" VARCHAR(160) NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "embedding" vector(768),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_chunks_chunk_id_key" ON "knowledge_chunks"("chunk_id");
CREATE INDEX IF NOT EXISTS "knowledge_chunks_crop_idx" ON "knowledge_chunks"("crop");
CREATE INDEX IF NOT EXISTS "knowledge_chunks_embedding_idx"
  ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);

CREATE OR REPLACE FUNCTION match_knowledge_chunks(
  query_embedding vector(768),
  match_threshold double precision,
  match_count integer,
  filter_crop text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  chunk_id varchar,
  crop varchar,
  disease varchar,
  disease_bn varchar,
  content text,
  metadata jsonb,
  similarity double precision
)
LANGUAGE sql STABLE AS $$
  SELECT
    k.id,
    k.chunk_id,
    k.crop,
    k.disease,
    k.disease_bn,
    k.content,
    k.metadata,
    1 - (k.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks k
  WHERE k.embedding IS NOT NULL
    AND (filter_crop IS NULL OR lower(k.crop) = lower(filter_crop))
    AND 1 - (k.embedding <=> query_embedding) >= match_threshold
  ORDER BY k.embedding <=> query_embedding
  LIMIT greatest(1, least(match_count, 10));
$$;