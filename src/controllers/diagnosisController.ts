import { Request, Response } from 'express';
import fs from 'fs';
import prisma from '../config/db';
import { AppError } from '../lib/errors';
import type { AuthRequest } from '../middleware/authMiddleware';
import { diagnoseLeafWithRAG } from '../services/ragService';
import {
  fallbackUpload,
  resolveCropScanImage,
  sniffImageMime,
  uploadCropScanImage,
  type UploadResult,
} from '../services/storageService';

interface TreatmentPayload {
  steps?: string[];
  organic?: string[];
  chemical?: string[];
  precautions?: string[];
  is_grounded_rag?: boolean;
  is_healthy?: boolean;
  pipeline_status?: string;
  matched_protocol_id?: string;
  crop_en?: string;
  crop_bn?: string;
  ai_disease_name?: string;
  ai_disease_name_en?: string;
  review_reason?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseTreatment(raw: string): TreatmentPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as TreatmentPayload) : {};
  } catch {
    return { steps: [raw] };
  }
}

function confidenceRatio(raw: number): number {
  const value = Number.isFinite(raw) ? raw : 0;
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

/** The wire shape is intentionally the same for scan, history and detail. */
async function toWireDiagnosis(diagnosis: {
  id: string;
  clientUuid: string | null;
  imageUrl: string;
  aiDetectedDisease: string;
  confidenceScore: number;
  treatmentSteps: string;
  status: string;
  timestamp: Date;
  expertReview: string | null;
  expertId: string | null;
}) {
  const parsed = parseTreatment(diagnosis.treatmentSteps);
  const ratio = confidenceRatio(diagnosis.confidenceScore);
  const healthy = parsed.is_healthy === true;
  // A healthy leaf has no protocol to cite, so it is final on its own; every
  // other final answer must be grounded in a retrieved protocol.
  const final =
    diagnosis.status === 'COMPLETED' &&
    ratio >= 0.70 &&
    (healthy || parsed.is_grounded_rag === true);
  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.map((text, index) => ({
        order: index + 1,
        text_bn: text,
        text_en: '',
        source: 'DAE/BRRI/BAMIS',
      }))
    : [];

  return {
    id: diagnosis.id,
    client_uuid: diagnosis.clientUuid ?? diagnosis.id,
    status: diagnosis.status.toLowerCase(),
    confidence: ratio,
    confidence_level: ratio >= 0.85 ? 'high' : ratio >= 0.70 ? 'medium' : 'low',
    show_as_final: final,
    image_url: await resolveCropScanImage(diagnosis.imageUrl),
    created_at: diagnosis.timestamp.toISOString(),
    crop: parsed.crop_en ? parsed.crop_en.toLowerCase() : null,
    disease: final
      ? {
          id: parsed.matched_protocol_id || diagnosis.id,
          name_bn: parsed.ai_disease_name || diagnosis.aiDetectedDisease,
          name_en: parsed.ai_disease_name_en || '',
          is_healthy: healthy,
        }
      : null,
    treatment_steps: final ? steps : null,
    organic_treatment: final ? parsed.organic ?? [] : null,
    chemical_treatment: final ? parsed.chemical ?? [] : null,
    precautions: final ? parsed.precautions ?? [] : null,
    is_grounded_rag: parsed.is_grounded_rag ?? false,
    review_reason: final
      ? null
      : parsed.review_reason || (parsed.is_grounded_rag === false ? 'ungrounded' : 'low_confidence'),
    reviewed_by_expert: Boolean(diagnosis.expertId),
    expert_note: diagnosis.expertReview,
  };
}

export const scanLeaf = async (req: AuthRequest, res: Response): Promise<void> => {
  const user = req.user;
  if (!user) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const file = req.file;
  if (!file) {
    throw new AppError(400, 'validation_error', 'No image uploaded', undefined, 'কোনো ছবি আপলোড করা হয়নি।');
  }

  const rawClientUuid = (req.body.client_uuid as string) || (req.body.clientUuid as string) || '';
  const clientUuid = rawClientUuid.trim() || null;
  if (clientUuid && !UUID_PATTERN.test(clientUuid)) {
    throw new AppError(
      400,
      'validation_error',
      'client_uuid must be a UUID',
      [{ field: 'client_uuid', message: 'client_uuid must be a UUID', message_bn: 'ছবির আইডি সঠিক নয়।' }],
      'ছবির আইডি সঠিক নয়।',
    );
  }

  // A retry of the same photo must return the original result, not duplicate it.
  if (clientUuid) {
    const existing = await prisma.diagnosis.findUnique({ where: { clientUuid } });
    if (existing) {
      if (existing.userId !== user.id) {
        throw new AppError(409, 'conflict', 'This photo id belongs to another account', undefined, 'এই ছবির আইডি অন্য অ্যাকাউন্টের।');
      }
      res.status(200).json({ success: true, data: await toWireDiagnosis(existing) });
      return;
    }
  }

  // Storage is not on the critical path: a bucket outage must still return the
  // diagnosis the farmer is waiting for. Losing the photo is recoverable;
  // losing the answer is not.
  let uploadResult: UploadResult;
  try {
    uploadResult = await uploadCropScanImage(file.path, file.originalname, file.mimetype);
  } catch (storageError) {
    console.error(
      '[Diagnosis] Image storage failed, continuing without a stored photo:',
      storageError instanceof Error ? storageError.message : storageError,
    );
    uploadResult = fallbackUpload(file.path);
  }

  const fileBuffer = fs.readFileSync(file.path);
  // The multipart part usually arrives as octet-stream; both the model and the
  // bucket need the real type, so it is read from the bytes once, here.
  const detectedMime = sniffImageMime(fileBuffer, file.originalname, file.mimetype);
  const hintCrop = typeof req.body.crop === 'string' ? req.body.crop : undefined;
  const ragResult = await diagnoseLeafWithRAG(fileBuffer, detectedMime, hintCrop);

  const ratio = confidenceRatio(ragResult.confidence);
  const healthy = ragResult.is_healthy === true;
  const rejected = ragResult.status === 'NOT_A_PLANT';
  const isFinal =
    !rejected &&
    ratio >= 0.70 &&
    (healthy || ragResult.is_grounded_rag === true);

  const reviewReason = isFinal
    ? null
    : rejected
      ? 'not_a_plant'
      : ragResult.status === 'UNSUPPORTED_CROP'
        ? 'unsupported_crop'
        : ragResult.status === 'UNSUPPORTED_DISEASE'
          ? 'unsupported_disease'
          : ragResult.status === 'NO_PROTOCOL'
            ? 'no_protocol'
            : !ragResult.is_grounded_rag && !healthy
              ? 'ungrounded'
              : 'low_confidence';

  const treatmentJson = JSON.stringify({
    steps: ragResult.treatment_steps,
    organic: ragResult.organic_treatment || [],
    chemical: ragResult.chemical_treatment || [],
    precautions: ragResult.precautions || [],
    is_grounded_rag: ragResult.is_grounded_rag,
    is_healthy: healthy,
    pipeline_status: ragResult.status,
    matched_protocol_id: ragResult.matched_protocol_id,
    crop_en: ragResult.crop_en,
    crop_bn: ragResult.crop_bn,
    ai_disease_name: ragResult.disease_name,
    ai_disease_name_en: ragResult.disease_name_en,
    review_reason: reviewReason,
  });

  const diagnosis = await prisma.diagnosis.create({
    data: {
      imageUrl: uploadResult.storagePath,
      aiDetectedDisease:
        ragResult.disease_name || ragResult.disease_name_en || 'Unknown',
      confidenceScore: ratio,
      treatmentSteps: treatmentJson,
      // A photo with no crop leaf is a failed scan, not a case for a human.
      status: rejected ? 'FAILED' : isFinal ? 'COMPLETED' : 'PENDING_REVIEW',
      clientUuid,
      userId: user.id,
    },
  });

  if (uploadResult.isRemote && fs.existsSync(file.path)) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      // The remote copy is authoritative; a leftover temp file is harmless.
    }
  }

  res.status(200).json({ success: true, data: await toWireDiagnosis(diagnosis) });
};

export const getDiagnosisHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  const user = req.user;
  if (!user) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
  const skip = (page - 1) * limit;

  const [diagnoses, total] = await Promise.all([
    prisma.diagnosis.findMany({
      where: { userId: user.id },
      orderBy: { timestamp: 'desc' },
      skip,
      take: limit,
    }),
    prisma.diagnosis.count({ where: { userId: user.id } }),
  ]);

  res.status(200).json({
    success: true,
    data: await Promise.all(diagnoses.map(toWireDiagnosis)),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

export const getDiagnosisDetail = async (req: AuthRequest, res: Response): Promise<void> => {
  const user = req.user;
  if (!user) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const diagnosis = await prisma.diagnosis.findFirst({
    where: { id: String(req.params.id), userId: user.id },
  });
  if (!diagnosis) {
    throw new AppError(404, 'not_found', 'Diagnosis not found', undefined, 'রোগ নির্ণয়ের তথ্য পাওয়া যায়নি।');
  }

  res.status(200).json({ success: true, data: await toWireDiagnosis(diagnosis) });
};

/** FR-24: move a completed but uncertain case into the expert queue. */
export const requestReview = async (req: AuthRequest, res: Response): Promise<void> => {
  const user = req.user;
  if (!user) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const diagnosis = await prisma.diagnosis.findFirst({
    where: { id: String(req.params.id), userId: user.id },
  });
  if (!diagnosis) {
    throw new AppError(404, 'not_found', 'Diagnosis not found', undefined, 'রোগ নির্ণয়ের তথ্য পাওয়া যায়নি।');
  }

  if (diagnosis.status === 'NEEDS_RETAKE') {
    throw new AppError(409, 'conflict', 'This case already needs a retake', undefined, 'এই ছবিটির জন্য নতুন ছবি চাওয়া হয়েছে।');
  }
  if (diagnosis.expertId) {
    throw new AppError(409, 'conflict', 'This case already has an expert review', undefined, 'এই ছবিটি ইতিমধ্যে একজন বিশেষজ্ঞ দেখেছেন।');
  }

  const updated = diagnosis.status === 'PENDING_REVIEW'
    ? diagnosis
    : await prisma.diagnosis.update({
        where: { id: diagnosis.id },
        data: { status: 'PENDING_REVIEW' },
      });

  res.status(200).json({ success: true, data: await toWireDiagnosis(updated) });
};
