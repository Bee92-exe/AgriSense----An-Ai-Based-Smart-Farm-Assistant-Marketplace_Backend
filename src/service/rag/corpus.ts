import fs from 'fs';
import path from 'path';
import type {
  Corpus,
  KnowledgeEntity,
  MeasureType,
  TreatmentMeasure,
} from './types';

const CORPUS_PATH = path.resolve(
  __dirname,
  '../../../agrisense_ai/data/agrisense_knowledge_base.json',
);

const MEASURE_TYPES = new Set<MeasureType>([
  'cultural',
  'biological',
  'chemical',
  'seed_treatment',
]);

/** Common names a vision model may use instead of the canonical corpus crop. */
const CROP_ALIASES: Record<string, string> = {
  paddy: 'Rice',
  dhan: 'Rice',
  ধান: 'Rice',
  corn: 'Maize',
  ভুট্টা: 'Maize',
  eggplant: 'Brinjal',
  aubergine: 'Brinjal',
  বেগুন: 'Brinjal',
  গম: 'Wheat',
  আলু: 'Potato',
  টমেটো: 'Tomato',
  মরিচ: 'Chilli',
  chili: 'Chilli',
  pepper: 'Chilli',
  সরিষা: 'Mustard',
  মসুর: 'Lentil',
  পাট: 'Jute',
  আম: 'Mango',
  কুমড়া: 'Cucurbits',
  gourd: 'Cucurbits',
  pumpkin: 'Cucurbits',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown): string | undefined {
  const cleaned = text(value);
  return cleaned || undefined;
}

function parseMeasure(
  raw: unknown,
  diseaseId: string,
  index: number,
): TreatmentMeasure {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Corpus ${diseaseId}: measure ${index} is not an object`);
  }

  const record = raw as Record<string, unknown>;
  const measureType = text(record.measure_type) as MeasureType;
  if (!MEASURE_TYPES.has(measureType)) {
    throw new Error(
      `Corpus ${diseaseId}: measure ${index} has unsupported type "${measureType}"`,
    );
  }

  const descriptionEn = text(record.description_en);
  if (!descriptionEn) {
    throw new Error(
      `Corpus ${diseaseId}: measure ${index} has no description_en`,
    );
  }

  return {
    measure_type: measureType,
    description_en: descriptionEn,
    description_bn: optionalText(record.description_bn),
    active_ingredient: optionalText(record.active_ingredient),
    product_name: optionalText(record.product_name),
    dose: optionalText(record.dose),
    timing: optionalText(record.timing),
    source_id: optionalText(record.source_id),
    source_name: optionalText(record.source_name),
    source_url: optionalText(record.source_url),
    flags: optionalText(record.flags),
  };
}

function parseEntity(key: string, raw: unknown): KnowledgeEntity {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Corpus entry ${key} is not an object`);
  }

  const record = raw as Record<string, unknown>;
  const diseaseId = text(record.disease_id) || key;
  const cropEn = text(record.crop_en);
  const cropBn = text(record.crop_bn) || cropEn;
  const diseaseEn = text(record.disease_en);
  const diseaseBn = text(record.disease_bn);
  const measuresRaw = record.measures;

  if (!cropEn || !diseaseEn) {
    throw new Error(`Corpus ${diseaseId}: crop_en and disease_en are required`);
  }
  if (!Array.isArray(measuresRaw) || measuresRaw.length === 0) {
    throw new Error(`Corpus ${diseaseId}: at least one measure is required`);
  }

  return {
    disease_id: diseaseId,
    crop_en: cropEn,
    crop_bn: cropBn,
    disease_en: diseaseEn,
    disease_bn: diseaseBn,
    pathogen: optionalText(record.pathogen),
    primary_source_id: optionalText(record.primary_source_id),
    measures: measuresRaw.map((measure, index) =>
      parseMeasure(measure, diseaseId, index),
    ),
  };
}

let cached: Corpus | null = null;

/**
 * Loads the authoritative structured corpus once. The JSON file is the source
 * of truth for both the seed script and the runtime prompt; the database holds
 * the embedded copy that retrieval actually reads.
 */
export function loadCorpus(): Corpus {
  if (cached) return cached;
  if (!fs.existsSync(CORPUS_PATH)) {
    throw new Error(`Knowledge corpus not found: ${CORPUS_PATH}`);
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Knowledge corpus must be an object keyed by disease id');
  }

  const entities = Object.entries(parsed as Record<string, unknown>).map(
    ([key, value]) => parseEntity(key, value),
  );

  const byDiseaseId = new Map<string, KnowledgeEntity>();
  const byCrop = new Map<string, KnowledgeEntity[]>();
  const supportedCrops: string[] = [];

  for (const entity of entities) {
    if (byDiseaseId.has(entity.disease_id)) {
      throw new Error(`Duplicate disease_id in corpus: ${entity.disease_id}`);
    }
    byDiseaseId.set(entity.disease_id, entity);

    const cropKey = entity.crop_en.toLowerCase();
    const cropEntities = byCrop.get(cropKey) ?? [];
    cropEntities.push(entity);
    byCrop.set(cropKey, cropEntities);

    if (!supportedCrops.some((crop) => crop.toLowerCase() === cropKey)) {
      supportedCrops.push(entity.crop_en);
    }
  }

  cached = { entities, byDiseaseId, byCrop, supportedCrops };
  return cached;
}

/** Canonical crop name for a model-returned crop id/name, or null. */
export function resolveCrop(cropId: string): string | null {
  const cleaned = cropId.trim();
  if (!cleaned) return null;

  const corpus = loadCorpus();
  const direct = corpus.supportedCrops.find(
    (crop) => crop.toLowerCase() === cleaned.toLowerCase(),
  );
  if (direct) return direct;

  const alias = CROP_ALIASES[cleaned.toLowerCase()];
  if (alias) return alias;

  return null;
}

/**
 * Canonical disease id for a model-returned id. This is intentionally strict:
 * an unrecognised name must become UNSUPPORTED_DISEASE, never a fuzzy match to
 * the nearest protocol.
 */
export function resolveDiseaseId(diseaseId: string): string | null {
  const cleaned = diseaseId.trim();
  if (!cleaned) return null;

  const corpus = loadCorpus();
  if (corpus.byDiseaseId.has(cleaned)) return cleaned;

  const normalized = cleaned
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return corpus.byDiseaseId.has(normalized) ? normalized : null;
}

export function corpusPromptCatalog(): string {
  return loadCorpus()
    .entities.map(
      (entity) =>
        `${entity.disease_id} | ${entity.crop_en} | ${entity.disease_en} | ${
          entity.disease_bn || entity.disease_en
        }`,
    )
    .join('\n');
}
