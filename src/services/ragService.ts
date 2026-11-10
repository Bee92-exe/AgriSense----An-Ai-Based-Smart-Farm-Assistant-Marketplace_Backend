import {
  corpusPromptCatalog,
  loadCorpus,
  resolveCrop,
  resolveDiseaseId,
} from './rag/corpus';
import { generateContent, requireGeminiKey, stripJsonFence } from './rag/gemini';
import { searchKnowledge } from './rag/retrieval';
import type { DiagnosisStatus, ImageQuality, KnowledgeEntity, KnowledgeMatch } from './rag/types';

export { getEmbedding } from './rag/gemini';
export { searchKnowledge } from './rag/retrieval';
export type { KnowledgeMatch } from './rag/types';

export interface DiagnosisResult {
  /** How the pipeline finished. Anything but HEALTHY/DIAGNOSED is not an answer. */
  status: DiagnosisStatus;
  crop_en: string;
  crop_bn: string;
  disease_id?: string;
  disease_name: string;
  disease_name_en: string;
  is_healthy: boolean;
  confidence: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  symptoms_bn?: string;
  treatment_steps: string[];
  organic_treatment?: string[];
  chemical_treatment?: string[];
  precautions?: string[];
  matched_protocol_id?: string;
  is_grounded_rag: boolean;
  rejection_reason?: string;
  image_quality?: ImageQuality;
}

/** A photo that is not a crop leaf is not a diagnosis; it must say so. */
const NOT_A_CROP_LEAF_BN = 'ফসলের পাতা শনাক্ত হয়নি';
const NOT_A_CROP_LEAF_EN = 'Not a crop leaf';
const HEALTHY_LEAF_BN = 'সুস্থ পাতা';

function clampPercent(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function normalizeSeverity(value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' {
  const cleaned = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return cleaned === 'LOW' || cleaned === 'MEDIUM' || cleaned === 'HIGH'
    ? cleaned
    : 'MEDIUM';
}

function normalizeQuality(value: unknown): ImageQuality {
  const cleaned = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return cleaned === 'BLURRY' || cleaned === 'DARK' || cleaned === 'TOO_FAR'
    ? cleaned
    : 'GOOD';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

interface VisionVerdict {
  is_crop_leaf: boolean;
  is_healthy: boolean;
  rejection_reason: string;
  crop_id: string;
  disease_id: string;
  confidence: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  symptoms_bn: string;
  image_quality: ImageQuality;
}

/**
 * Validates the vision JSON instead of trusting it: a missing boolean is false,
 * an unreadable figure is 0 confidence. A malformed answer must never become a
 * confident diagnosis.
 */
function readVisionVerdict(raw: string): VisionVerdict {
  const parsed: unknown = JSON.parse(stripJsonFence(raw));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Vision response was not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const asText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  return {
    is_crop_leaf: record.is_crop_leaf === true,
    is_healthy: record.is_healthy === true,
    rejection_reason: asText(record.rejection_reason),
    crop_id: asText(record.crop_id),
    disease_id: asText(record.disease_id),
    confidence: clampPercent(record.confidence),
    severity: normalizeSeverity(record.severity),
    symptoms_bn: asText(record.symptoms_bn),
    image_quality: normalizeQuality(record.image_quality),
  };
}

/** Verbatim corpus steps, used when the synthesis model cannot be used. */
function stepsFromCorpus(entity: KnowledgeEntity | undefined): string[] {
  if (!entity) return [];
  return entity.measures.map((measure, index) => {
    const description = (measure.description_bn || measure.description_en).trim();
    const dose = measure.dose ? ` (মাত্রা: ${measure.dose})` : '';
    const timing = measure.timing ? ` — সময়: ${measure.timing}` : '';
    return `ধাপ ${index + 1}: ${description}${dose}${timing}`;
  });
}

export interface VoiceAssistantResult {
  reply: string;
  intent?: 'NAVIGATE_MARKET' | 'NAVIGATE_WEATHER' | 'NAVIGATE_SCAN' | 'AGRI_ADVICE';
  found?: boolean;
  sources?: VoiceAssistantSource[];
  offer_expert?: boolean;
  matched_crop?: string;
  matched_disease?: string;
}

export interface VoiceAssistantSource {
  title: string;
  kb_id?: string;
}

// Embedding and retrieval live in ./rag/gemini.ts and ./rag/retrieval.ts so the
// seed script, the diagnosis pipeline and tests share one implementation.

/**
 * End-to-end Multimodal Leaf Scan with RAG Grounding:
 * 1. Gemini Vision analyzes crop leaf photo.
 * 2. Vector search retrieves exact Bangladesh DAE/BRRI protocol.
 * 3. Gemini synthesizes final verified Bangla treatment steps.
 */
export async function diagnoseLeafWithRAG(
  imageBuffer: Buffer,
  mimeType: string,
  hintCrop?: string
): Promise<DiagnosisResult> {
  requireGeminiKey();

  // Gemini rejects `application/octet-stream` in inline_data, which is exactly
  // what a multipart photo from the app used to carry. A non-image type is
  // therefore treated as JPEG instead of failing the whole scan; the bytes are
  // still the same photo and the vision prompt judges the content.
  const safeMime = mimeType && mimeType.toLowerCase().startsWith('image/') ? mimeType : 'image/jpeg';
  const imagePart = {
    inlineData: {
      data: imageBuffer.toString('base64'),
      mimeType: safeMime
    }
  };

  const hint = hintCrop ? resolveCrop(hintCrop) : null;

  // The catalog is the complete list of diseases this service may speak about.
  // Pinning the model to it is what turns retrieval into an exact-id lookup
  // instead of "whichever chunk is nearest to this sentence".
  const detectPrompt = `You are a plant pathologist reading ONE photo for a Bangladesh crop advisory service.

STEP 1 - Is this a photo of a crop leaf at all? A notebook page, paper, a screenshot, a hand, soil, a tool, a building, an animal, or an unusable/blurry photo is NOT a crop leaf. For those set "is_crop_leaf" to false, give a short "rejection_reason", and leave crop_id and disease_id empty. Never name a disease for a photo that does not show a crop leaf.

STEP 2 - Crop. Use exactly one of: ${loadCorpus().supportedCrops.join(', ')}.

STEP 3 - Disease. "disease_id" MUST be copied exactly from this catalog:
${corpusPromptCatalog()}

If the visible symptoms match none of those ids, return an empty disease_id. Never choose the closest-looking one and never invent an id.
${hint ? `The farmer said the crop is ${hint}; the photo wins if they disagree.` : ''}
STEP 4 - If the leaf shows no lesion, spot, blight, discolouration, or pest damage, set "is_healthy" to true and leave disease_id empty.

"confidence" is 0-100 and reflects only what is visible. A dim, distant or ambiguous photo must score below 60.
"symptoms_bn" describes only what is visible, in Bengali.
"image_quality" is one of GOOD, BLURRY, DARK, TOO_FAR.

Return ONLY raw JSON, no markdown:
{"is_crop_leaf":true,"rejection_reason":"","is_healthy":false,"crop_id":"<crop name>","disease_id":"<exact id from the catalog, or empty>","confidence":<0-100>,"severity":"LOW|MEDIUM|HIGH","symptoms_bn":"<visible symptoms in Bengali>","image_quality":"GOOD|BLURRY|DARK|TOO_FAR"}`;

  let verdict: VisionVerdict;
  try {
    verdict = readVisionVerdict(await generateContent([detectPrompt, imagePart]));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[RAG] Vision model failed:', message);
    throw new Error('Image analysis failed: ' + message);
  }

  // A photo with no crop leaf in it has no disease. This used to fall through
  // into detection, so a notebook page came back as whatever disease the
  // nearest chunk happened to be.
  if (!verdict.is_crop_leaf) {
    return {
      status: 'NOT_A_PLANT',
      crop_en: '',
      crop_bn: '',
      disease_name: NOT_A_CROP_LEAF_BN,
      disease_name_en: NOT_A_CROP_LEAF_EN,
      is_healthy: false,
      confidence: 0,
      severity: 'MEDIUM',
      symptoms_bn: '',
      treatment_steps: [],
      is_grounded_rag: false,
      rejection_reason: verdict.rejection_reason || 'not_a_crop_leaf',
      image_quality: verdict.image_quality
    };
  }

  const crop = resolveCrop(verdict.crop_id);
  const cropEn = crop ?? '';
  const cropBn = crop ? loadCorpus().entities.find((e) => e.crop_en === crop)?.crop_bn ?? '' : '';

  if (!crop) {
    // An unsupported crop must not borrow another crop's protocol.
    return {
      status: 'UNSUPPORTED_CROP',
      crop_en: verdict.crop_id,
      crop_bn: '',
      disease_name: 'অসমর্থিত ফসল',
      disease_name_en: 'Unsupported crop',
      is_healthy: false,
      confidence: Math.min(69, verdict.confidence),
      severity: verdict.severity,
      symptoms_bn: verdict.symptoms_bn,
      treatment_steps: [],
      is_grounded_rag: false,
      rejection_reason: 'unsupported_crop',
      image_quality: verdict.image_quality
    };
  }

  if (verdict.is_healthy) {
    return {
      status: 'HEALTHY',
      crop_en: cropEn,
      crop_bn: cropBn,
      disease_name: HEALTHY_LEAF_BN,
      disease_name_en: 'Healthy leaf',
      is_healthy: true,
      confidence: verdict.confidence,
      severity: 'LOW',
      symptoms_bn: verdict.symptoms_bn,
      treatment_steps: [],
      is_grounded_rag: false,
      image_quality: verdict.image_quality
    };
  }

  const diseaseId = resolveDiseaseId(verdict.disease_id);
  if (!diseaseId) {
    // Strict on purpose: no id from the catalog means no protocol exists, so
    // this goes to a human instead of being matched to the nearest disease.
    return {
      status: 'UNSUPPORTED_DISEASE',
      crop_en: cropEn,
      crop_bn: cropBn,
      disease_name: verdict.disease_id
        ? `শনাক্তকৃত রোগ (${verdict.disease_id})`
        : 'অজ্ঞাত রোগ',
      disease_name_en: verdict.disease_id || 'Unknown disease',
      is_healthy: false,
      confidence: Math.min(69, verdict.confidence),
      severity: verdict.severity,
      symptoms_bn: verdict.symptoms_bn,
      treatment_steps: [],
      is_grounded_rag: false,
      rejection_reason: 'unsupported_disease',
      image_quality: verdict.image_quality
    };
  }

  const entity = loadCorpus().byDiseaseId.get(diseaseId);
  const diseaseBn = entity?.disease_bn || verdict.disease_id || diseaseId;
  const diseaseEn = entity?.disease_en || verdict.disease_id || diseaseId;

  // Step 2: retrieve the one official protocol for this exact disease id.
  let matches: KnowledgeMatch[] = [];
  try {
    matches = await searchKnowledge(
      `${cropEn} ${diseaseEn} ${diseaseBn} ${verdict.symptoms_bn}`,
      { crop: cropEn, diseaseId, threshold: 0.2, limit: 2 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.warn('[RAG] Vector retrieval failed:', message);
  }

  const bestMatch = matches.length > 0 ? matches[0] : null;
  if (!bestMatch) {
    return {
      status: 'NO_PROTOCOL',
      crop_en: cropEn,
      crop_bn: cropBn,
      disease_id: diseaseId,
      disease_name: diseaseBn,
      disease_name_en: diseaseEn,
      is_healthy: false,
      confidence: Math.min(69, verdict.confidence),
      severity: verdict.severity,
      symptoms_bn: verdict.symptoms_bn,
      treatment_steps: [],
      is_grounded_rag: false,
      rejection_reason: 'no_protocol',
      image_quality: verdict.image_quality
    };
  }

  // Step 3: grounded synthesis, strictly inside the retrieved protocol.
  const synthesisPrompt = `You are AgriSense AI, an agricultural advisory system in Bangladesh.
A farmer's crop photo was diagnosed as:
Crop: ${cropBn} (${cropEn})
Disease: ${diseaseBn} (${diseaseEn})
Severity: ${verdict.severity}

OFFICIAL BANGLADESH EXTENSION PROTOCOL (DAE/BAMIS/BRRI):
"""
${bestMatch.content}
"""

GROUNDING RULES:
1. Provide practical, step-by-step treatment steps strictly in Bengali for a Bangladeshi farmer.
2. Ground all chemical sprays and dosages strictly on the official protocol above. Do NOT invent chemicals or dosages.
3. If cultural/organic measures are available, list them clearly.
4. Include precautionary measures (e.g. wearing mask, spraying in afternoon, withholding harvest period).
5. If the protocol does not state a dose, say the dose must be confirmed with the agriculture officer instead of supplying one.

Return ONLY raw JSON:
{
  "treatment_steps": ["ধাপ ১: ...", "ধাপ ২: ..."],
  "organic_treatment": ["জৈব ব্যবস্থা ১: ..."],
  "chemical_treatment": ["অনুমোদিত স্প্রে ও মাত্রা: ..."],
  "precautions": ["সতর্কতা: ..."]
}`;

  let synthesized: {
    steps: string[];
    organic: string[];
    chemical: string[];
    precautions: string[];
  } | null = null;

  try {
    const raw = await generateContent(synthesisPrompt);
    const parsed: unknown = JSON.parse(stripJsonFence(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const steps = stringList(record.treatment_steps);
      if (steps.length > 0) {
        synthesized = {
          steps,
          organic: stringList(record.organic_treatment),
          chemical: stringList(record.chemical_treatment),
          precautions: stringList(record.precautions)
        };
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.warn('[RAG] Synthesis failed, using the protocol verbatim:', message);
  }

  // The protocol itself is authoritative, so its own sentences are a safe
  // answer when the synthesis model is unavailable. Nothing is invented.
  const steps = synthesized?.steps ?? stepsFromCorpus(entity);

  return {
    status: 'DIAGNOSED',
    crop_en: cropEn,
    crop_bn: cropBn,
    disease_id: diseaseId,
    disease_name: diseaseBn,
    disease_name_en: diseaseEn,
    is_healthy: false,
    confidence: verdict.confidence,
    severity: verdict.severity,
    symptoms_bn: verdict.symptoms_bn,
    treatment_steps: steps,
    organic_treatment: synthesized?.organic ?? [],
    chemical_treatment: synthesized?.chemical ?? [],
    precautions: synthesized?.precautions ?? [],
    matched_protocol_id: bestMatch.chunk_id,
    is_grounded_rag: true,
    image_quality: verdict.image_quality
  };
}

/**
 * Voice Assistant & Agricultural Q&A with RAG
 */
export async function answerVoiceQueryWithRAG(query: string): Promise<VoiceAssistantResult> {
  const cleanQuery = query.trim().toLowerCase();

  // 1. Detect Voice Commands (Navigation & Quick Actions)
  if (cleanQuery.includes('বাজার') || cleanQuery.includes('হাট') || cleanQuery.includes('পণ্য') || cleanQuery.includes('মার্কেট')) {
    return {
      reply: 'আপনাকে কৃষি হাটে নিয়ে যাওয়া হচ্ছে। এখানে আপনি বীজ, সার ও কৃষি সরঞ্জাম কিনতে পারবেন।',
      intent: 'NAVIGATE_MARKET'
    };
  }

  if (cleanQuery.includes('আবহাওয়া') || cleanQuery.includes('বৃষ্টি') || cleanQuery.includes('তাপমাত্রা')) {
    return {
      reply: 'আপনার এলাকার আবহাওয়া এবং সেচ পরামর্শ দেখতে আবহাওয়া পেজে নিয়ে যাচ্ছি।',
      intent: 'NAVIGATE_WEATHER'
    };
  }

  if (cleanQuery.includes('স্ক্যান') || cleanQuery.includes('ছবি তুলব') || cleanQuery.includes('ক্যামেরা')) {
    return {
      reply: 'পাতার ছবি তোলার জন্য স্ক্যানার ক্যামেরা খোলা হচ্ছে।',
      intent: 'NAVIGATE_SCAN'
    };
  }

  // 2. Agricultural Knowledge Query via Vector Search
  const matches = await searchKnowledge(query, { threshold: 0.42, limit: 2 });
  requireGeminiKey();

  const sources: VoiceAssistantSource[] = matches.map((match) => {
    const sourceList = Array.isArray(match.metadata?.sources)
      ? match.metadata.sources.filter((value: unknown): value is string => typeof value === 'string')
      : [];
    return {
      title: sourceList[0] || `${match.crop} · ${match.disease_bn}`,
      kb_id: match.chunk_id,
    };
  });

  // A finite, source-grounded corpus must be allowed to say "I do not know".
  if (matches.length === 0) {
    return {
      reply:
        'এই প্রশ্নের নির্ভরযোগ্য উত্তর আমার কাছে নেই। নিকটস্থ কৃষি কর্মকর্তা বা বিশেষজ্ঞের সাথে পরামর্শ করুন।',
      intent: 'AGRI_ADVICE',
      found: false,
      sources: [],
      offer_expert: true,
    };
  }

  let contextText = '';
  if (matches.length > 0) {
    contextText = `বাংলাদেশ কৃষি সম্প্রসারণ অধিদপ্তর (DAE) ও বিআরআরআই অনুমোদিত তথ্য:\n` +
      matches.map(m => m.content).join('\n---\n');
  }

  const prompt = `You are "AgriBot" (এগ্রিবট), an expert agricultural voice assistant for Bangladeshi farmers.
A farmer asks: "${query}"

${contextText ? `GROUNDING CONTEXT (Use this verified information):\n${contextText}` : ''}

RULES:
1. Reply strictly in simple, respectful Bengali (বাংলা).
2. Answer must be maximum 2 to 3 concise, natural sentences suitable for Text-to-Speech playback.
3. Do NOT use markdown like asterisks (*), hashtags (#), or bullet points. Use plain conversational sentences.
4. Give direct actionable advice (e.g., approved medicine, dose, or care step in Bangladesh).
5. If the supplied context does not answer the question, say that you do not have a verified answer instead of inventing one.`;

  const replyText = (await generateContent(prompt)).trim();

  return {
    reply: replyText,
    intent: 'AGRI_ADVICE',
    found: true,
    sources,
    offer_expert: false,
    matched_crop: matches[0]?.crop,
    matched_disease: matches[0]?.disease_bn
  };
}
