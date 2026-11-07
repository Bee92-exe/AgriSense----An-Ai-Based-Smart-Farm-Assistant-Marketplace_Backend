import prisma from '../../config/db';
import { getEmbedding } from './gemini';
import type { KnowledgeMatch, KnowledgeMetadata } from './types';

export interface SearchKnowledgeOptions {
  crop?: string;
  diseaseId?: string;
  threshold?: number;
  limit?: number;
}

interface RawKnowledgeRow {
  id: string;
  chunk_id: string;
  crop: string;
  disease: string;
  disease_bn: string;
  disease_id: string | null;
  content: string;
  metadata: unknown;
  similarity: number | string | null;
}

function normalizeMetadata(value: unknown): KnowledgeMetadata {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as KnowledgeMetadata;
      }
    } catch {
      return {};
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as KnowledgeMetadata;
  }
  return {};
}

function normalizeRow(row: RawKnowledgeRow): KnowledgeMatch {
  return {
    ...row,
    disease_id: row.disease_id ?? null,
    metadata: normalizeMetadata(row.metadata),
    similarity: row.similarity == null ? null : Number(row.similarity),
  };
}

/**
 * Semantic search over the embedded knowledge chunks, always constrained by
 * the exact disease id when one is known. Similarity only ranks candidates
 * inside that disease; it can never move the query to another disease.
 *
 * If the query embedding fails but a disease id is known, the exact protocol
 * row is still returned. That is the safe degradation: the protocol is correct
 * by construction, only its similarity score is unavailable.
 */
export async function searchKnowledge(
  queryText: string,
  options: SearchKnowledgeOptions = {},
): Promise<KnowledgeMatch[]> {
  const { crop, diseaseId, threshold = 0.35, limit = 3 } = options;
  const normalizedLimit = Math.max(1, Math.min(Math.trunc(limit), 10));

  let embedding: number[] | null = null;
  try {
    embedding = await getEmbedding(queryText);
  } catch (error) {
    if (!diseaseId) throw error;
    console.warn(
      `[RAG] Embedding failed; using exact disease lookup for ${diseaseId}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }

  let rows: RawKnowledgeRow[];
  if (embedding) {
    const vector = `[${embedding.join(',')}]`;
    rows = await prisma.$queryRaw<RawKnowledgeRow[]>`
      SELECT
        id,
        chunk_id,
        crop,
        disease,
        disease_bn,
        disease_id,
        content,
        metadata,
        1 - (embedding <=> ${vector}::vector) AS similarity
      FROM knowledge_chunks
      WHERE embedding IS NOT NULL
        AND (${diseaseId ?? null}::text IS NULL OR disease_id = ${diseaseId ?? null})
        AND (${crop ?? null}::text IS NULL OR lower(crop) = lower(${crop ?? null}))
        AND 1 - (embedding <=> ${vector}::vector) >= ${threshold}
      ORDER BY embedding <=> ${vector}::vector
      LIMIT ${normalizedLimit}
    `;
  } else {
    // The caller only reaches this branch with a diseaseId; the exact key is
    // the grounding guarantee, so no embedding score is required.
    rows = await prisma.$queryRaw<RawKnowledgeRow[]>`
      SELECT
        id,
        chunk_id,
        crop,
        disease,
        disease_bn,
        disease_id,
        content,
        metadata,
        NULL::double precision AS similarity
      FROM knowledge_chunks
      WHERE disease_id = ${diseaseId}
        AND (${crop ?? null}::text IS NULL OR lower(crop) = lower(${crop ?? null}))
      ORDER BY chunk_id
      LIMIT ${normalizedLimit}
    `;
  }

  return rows.map(normalizeRow);
}
