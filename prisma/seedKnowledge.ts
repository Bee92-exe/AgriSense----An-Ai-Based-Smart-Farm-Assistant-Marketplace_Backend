import fs from 'fs';
import path from 'path';
import prisma from '../src/config/db';
import { getEmbedding } from '../src/services/ragService';
import { loadCorpus } from '../src/services/rag/corpus';
import type { TreatmentMeasure } from '../src/services/rag/types';

interface CorpusChunk {
  chunk_id: string;
  disease_id?: string;
  crop_en: string;
  crop_bn: string;
  disease_en: string;
  disease_bn: string;
  text: string;
  metadata?: Record<string, unknown>;
}

const CORPUS_PATH = path.resolve(
  __dirname,
  '../agrisense_ai/data/agrisense_knowledge_chunks.jsonl',
);

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function gapSummary(measures: TreatmentMeasure[]): {
  missingDose: number;
  regulatory: number;
} {
  let missingDose = 0;
  let regulatory = 0;
  for (const measure of measures) {
    const dose = text(measure.dose).toLowerCase();
    if (!dose || dose.includes('not specified') || dose.includes('not given')) {
      missingDose += 1;
    }
    if (text(measure.flags).toUpperCase().includes('REGULATORY_CHECK')) {
      regulatory += 1;
    }
  }
  return { missingDose, regulatory };
}

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY?.trim()) {
    throw new Error('GEMINI_API_KEY is required to create RAG embeddings');
  }
  if (!fs.existsSync(CORPUS_PATH)) {
    throw new Error(`Knowledge corpus not found: ${CORPUS_PATH}`);
  }

  const corpus = loadCorpus();
  const lines = fs
    .readFileSync(CORPUS_PATH, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  console.log(
    `Seeding ${lines.length} chunks from ${CORPUS_PATH} (${corpus.entities.length} structured diseases)`,
  );

  const seenDiseaseIds = new Set<string>();
  let seeded = 0;
  let missingBangla = 0;
  let missingDose = 0;
  let regulatory = 0;

  for (const line of lines) {
    const chunk = JSON.parse(line) as CorpusChunk;
    if (!chunk.chunk_id || !chunk.text) {
      throw new Error('Corpus chunk is missing chunk_id or text');
    }

    const diseaseId = text(chunk.disease_id);
    if (!diseaseId) {
      throw new Error(`Corpus chunk ${chunk.chunk_id} is missing disease_id`);
    }

    const entity = corpus.byDiseaseId.get(diseaseId);
    if (!entity) {
      throw new Error(
        `Corpus chunk ${chunk.chunk_id} references unknown disease_id ${diseaseId}`,
      );
    }
    if (seenDiseaseIds.has(diseaseId)) {
      throw new Error(`Duplicate chunk for disease_id ${diseaseId}`);
    }
    seenDiseaseIds.add(diseaseId);

    const measures = entity.measures.map((measure, index) => ({
      measure_index: index,
      ...measure,
    }));
    const gaps = gapSummary(entity.measures);
    missingDose += gaps.missingDose;
    regulatory += gaps.regulatory;
    if (!entity.disease_bn) missingBangla += 1;

    const metadata = {
      ...(chunk.metadata ?? {}),
      disease_id: diseaseId,
      crop_en: entity.crop_en,
      crop_bn: entity.crop_bn,
      disease_en: entity.disease_en,
      disease_bn: entity.disease_bn,
      measures,
    };

    const embedding = await getEmbedding(
      `${entity.crop_en} | ${entity.disease_en} | ${entity.disease_bn} | ${chunk.text}`,
    );
    if (embedding.length !== 768) {
      throw new Error(
        `Expected 768 dimensions for ${chunk.chunk_id}, got ${embedding.length}`,
      );
    }

    await prisma.$executeRaw`
      INSERT INTO knowledge_chunks
        (chunk_id, crop, disease, disease_id, disease_bn, content, metadata, embedding)
      VALUES (
        ${chunk.chunk_id},
        ${entity.crop_en},
        ${entity.disease_en},
        ${diseaseId},
        ${entity.disease_bn || entity.disease_en},
        ${chunk.text},
        ${JSON.stringify(metadata)}::jsonb,
        ${`[${embedding.join(',')}]`}::vector
      )
      ON CONFLICT (chunk_id) DO UPDATE SET
        crop = EXCLUDED.crop,
        disease = EXCLUDED.disease,
        disease_id = EXCLUDED.disease_id,
        disease_bn = EXCLUDED.disease_bn,
        content = EXCLUDED.content,
        metadata = EXCLUDED.metadata,
        embedding = EXCLUDED.embedding
    `;

    seeded += 1;
    if (seeded % 10 === 0 || seeded === lines.length) {
      console.log(`  ${seeded}/${lines.length}`);
    }
  }

  const missingEntities = corpus.entities.filter(
    (entity) => !seenDiseaseIds.has(entity.disease_id),
  );
  if (missingEntities.length > 0) {
    throw new Error(
      `Corpus chunks are missing ${missingEntities.length} diseases: ${missingEntities
        .map((entity) => entity.disease_id)
        .join(', ')}`,
    );
  }

  console.log(`Knowledge base ready: ${seeded} chunks`);
  console.log(
    `Data gaps (not invented): ${missingBangla} missing Bangla disease names, ${missingDose} measures without a dose, ${regulatory} regulatory-flagged measures`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(
      '[seed:knowledge] failed:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
