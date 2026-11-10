/** Shared types for the RAG knowledge base, vision contract and treatment plan. */

export type MeasureType =
  | 'cultural'
  | 'biological'
  | 'chemical'
  | 'seed_treatment';

export interface TreatmentMeasure {
  measure_type: MeasureType;
  description_en: string;
  description_bn?: string;
  active_ingredient?: string;
  product_name?: string;
  dose?: string;
  timing?: string;
  source_id?: string;
  source_name?: string;
  source_url?: string;
  flags?: string;
}

export interface KnowledgeEntity {
  disease_id: string;
  crop_en: string;
  crop_bn: string;
  disease_en: string;
  disease_bn: string;
  pathogen?: string;
  primary_source_id?: string;
  measures: TreatmentMeasure[];
}

export interface Corpus {
  entities: KnowledgeEntity[];
  byDiseaseId: Map<string, KnowledgeEntity>;
  byCrop: Map<string, KnowledgeEntity[]>;
  supportedCrops: string[];
}

export interface KnowledgeMetadata {
  crop?: string;
  crop_en?: string;
  crop_bn?: string;
  disease?: string;
  disease_id?: string;
  disease_bn?: string;
  measures?: Array<TreatmentMeasure & { measure_index: number }>;
  sources?: string[];
  [key: string]: unknown;
}

export interface KnowledgeMatch {
  id: string;
  chunk_id: string;
  crop: string;
  disease: string;
  disease_bn: string;
  disease_id: string | null;
  content: string;
  metadata: KnowledgeMetadata;
  similarity: number | null;
}

export type DiagnosisStatus =
  | 'DIAGNOSED'
  | 'HEALTHY'
  | 'NOT_A_PLANT'
  | 'UNSUPPORTED_CROP'
  | 'UNSUPPORTED_DISEASE'
  | 'NO_PROTOCOL'
  | 'LOW_CONFIDENCE'
  | 'NEEDS_RETAKE'
  | 'RETRIEVAL_UNAVAILABLE'
  | 'VISION_FAILED';

export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type ImageQuality = 'GOOD' | 'BLURRY' | 'DARK' | 'TOO_FAR';

export interface VisionAlternative {
  disease_id: string;
  confidence: number;
}

/**
 * The exact object Gemini is allowed to return. `confidence` is 0-100. The
 * parser validates every value; nothing is defaulted to a high score.
 */
export interface VisionDetection {
  is_crop_leaf: boolean;
  is_healthy: boolean;
  rejection_reason: string;
  crop_id: string;
  disease_id: string;
  confidence: number;
  severity: ConfidenceLevel;
  symptoms_bn: string;
  image_quality: ImageQuality;
  alternatives: VisionAlternative[];
}

export interface TreatmentStep {
  order: number;
  text_bn: string;
  text_en: string;
  source: string;
  measure_type: MeasureType;
  dose?: string;
  dose_status?: 'stated' | 'not_in_source' | 'verify';
  flags?: string[];
  translation_status?: 'verified' | 'unverified' | 'source_only';
}

export interface BlockedMeasure {
  measure_type: MeasureType;
  description_en: string;
  product_name?: string;
  active_ingredient?: string;
  reason: string;
}

export interface TreatmentAlternative {
  disease_id: string;
  name_bn: string;
  name_en: string;
  confidence: number;
}

export interface DiagnosisResult {
  status: DiagnosisStatus;
  crop_en: string;
  crop_bn: string;
  disease_id?: string;
  disease_name: string;
  disease_name_en: string;
  confidence: number;
  severity: ConfidenceLevel;
  symptoms_bn?: string;
  treatment_steps: TreatmentStep[];
  organic_treatment?: string[];
  chemical_treatment?: string[];
  precautions?: string[];
  blocked_measures?: BlockedMeasure[];
  alternatives?: TreatmentAlternative[];
  matched_protocol_id?: string;
  matched_chunk_id?: string;
  is_grounded_rag: boolean;
  review_reason?: string;
  image_quality?: ImageQuality;
}
