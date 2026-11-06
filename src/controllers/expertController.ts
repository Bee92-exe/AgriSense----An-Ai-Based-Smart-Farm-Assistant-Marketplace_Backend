import { Request, Response } from 'express';
import prisma from '../config/db';
import { AppError } from '../lib/errors';
import type { AuthRequest } from '../middleware/authMiddleware';
import { resolveCropScanImage } from '../services/storageService';

interface TreatmentPayload {
  crop_en?: string;
  review_reason?: string;
  ai_disease_name?: string;
  is_grounded_rag?: boolean;
}

function parseTreatment(raw: string): TreatmentPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as TreatmentPayload) : {};
  } catch {
    return {};
  }
}

function confidenceRatio(raw: number): number {
  const value = Number.isFinite(raw) ? raw : 0;
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

async function expertFor(userId: string) {
  const expert = await prisma.expert.findUnique({ where: { userId } });
  if (!expert) {
    throw new AppError(403, 'forbidden', 'Expert profile not found', undefined, 'বিশেষজ্ঞের প্রোফাইল পাওয়া যায়নি।');
  }
  return expert;
}

// Get the real low-confidence queue for an approved expert.
export const getPendingDiagnoses = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');
  await expertFor(userId);

  const diagnoses = await prisma.diagnosis.findMany({
    where: { status: 'PENDING_REVIEW' },
    include: {
      user: { select: { name: true, location: true } },
    },
    orderBy: { timestamp: 'asc' },
    take: 50,
  });

  const mapped = await Promise.all(
    diagnoses.map(async (diagnosis) => {
      const parsed = parseTreatment(diagnosis.treatmentSteps);
      return {
        id: diagnosis.id,
        crop: parsed.crop_en?.toLowerCase() ?? null,
        disease: diagnosis.aiDetectedDisease,
        confidence: confidenceRatio(diagnosis.confidenceScore),
        imageUrl: await resolveCropScanImage(diagnosis.imageUrl),
        date: diagnosis.timestamp,
        farmerName: diagnosis.user?.name || 'Unknown',
        farmerLocation: diagnosis.user?.location || '',
        hasImage: Boolean(diagnosis.imageUrl),
        reviewReason: parsed.review_reason || 'low_confidence',
        ai_top3: parsed.ai_disease_name
          ? [{
              disease_id: diagnosis.id,
              name_bn: parsed.ai_disease_name,
              name_en: '',
              confidence: confidenceRatio(diagnosis.confidenceScore),
            }]
          : [],
      };
    }),
  );

  res.status(200).json({ success: true, diagnoses: mapped });
};

export const reviewDiagnosis = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');
  const expert = await expertFor(userId);

  const diagnosisId = String(req.params.id);
  const { review, note, diseaseName } = req.body as {
    review?: string;
    note?: string;
    diseaseName?: string;
  };
  const reviewText = (review ?? note ?? '').trim();
  if (reviewText.length < 3) {
    throw new AppError(
      400,
      'validation_error',
      'A review note is required',
      [{ field: 'review', message: 'A review note is required', message_bn: 'পর্যালোচনার মন্তব্য লিখুন।' }],
      'পর্যালোচনার মন্তব্য লিখুন।',
    );
  }

  const diagnosis = await prisma.diagnosis.findUnique({ where: { id: diagnosisId } });
  if (!diagnosis) {
    throw new AppError(404, 'not_found', 'Diagnosis not found', undefined, 'রোগ নির্ণয়ের তথ্য পাওয়া যায়নি।');
  }
  if (diagnosis.status !== 'PENDING_REVIEW') {
    throw new AppError(409, 'conflict', 'This case is not pending review', undefined, 'এই ছবিটি পর্যালোচনার অপেক্ষায় নেই।');
  }

  const confirmedName = typeof diseaseName === 'string' ? diseaseName.trim() : '';
  const treatment = parseTreatment(diagnosis.treatmentSteps);
  const treatmentJson = confirmedName
    ? JSON.stringify({
        ...treatment,
        ai_disease_name: confirmedName,
        is_grounded_rag: true,
      })
    : diagnosis.treatmentSteps;

  const updated = await prisma.diagnosis.update({
    where: { id: diagnosisId },
    data: {
      expertReview: reviewText,
      expertId: expert.id,
      status: 'COMPLETED',
      ...(confirmedName
        ? {
            aiDetectedDisease: confirmedName,
            // The expert has now confirmed the name; the case is no longer a
            // low-confidence AI guess for the farmer.
            confidenceScore: Math.max(diagnosis.confidenceScore, 0.9),
            treatmentSteps: treatmentJson,
          }
        : {}),
    },
  });

  res.status(200).json({
    success: true,
    diagnosis: {
      id: updated.id,
      status: 'completed',
      reviewed_by_expert: true,
      expert_note: updated.expertReview,
      disease_name: diseaseName || updated.aiDetectedDisease,
    },
  });
};

/** Expert cannot confirm the photo; ask for a new, clearer scan. */
export const needsRetake = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');
  const expert = await expertFor(userId);

  const diagnosisId = String(req.params.id);
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';

  const diagnosis = await prisma.diagnosis.findUnique({ where: { id: diagnosisId } });
  if (!diagnosis) {
    throw new AppError(404, 'not_found', 'Diagnosis not found', undefined, 'রোগ নির্ণয়ের তথ্য পাওয়া যায়নি।');
  }
  if (diagnosis.status !== 'PENDING_REVIEW') {
    throw new AppError(409, 'conflict', 'This case is not pending review', undefined, 'এই ছবিটি পর্যালোচনার অপেক্ষায় নেই।');
  }

  const updated = await prisma.diagnosis.update({
    where: { id: diagnosisId },
    data: {
      expertReview: note || 'অনুগ্রহ করে আরও পরিষ্কার আলোতে পাতার ছবি তুলুন।',
      expertId: expert.id,
      status: 'NEEDS_RETAKE',
    },
  });

  res.status(200).json({
    success: true,
    diagnosis: {
      id: updated.id,
      status: 'needs_retake',
      expert_note: updated.expertReview,
    },
  });
};

export const getExpertStats = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');
  const expert = await expertFor(userId);

  const [totalReviewed, pendingReview, articlesWritten] = await Promise.all([
    prisma.diagnosis.count({ where: { expertId: expert.id } }),
    prisma.diagnosis.count({ where: { status: 'PENDING_REVIEW' } }),
    prisma.knowledgeBase.count({ where: { expertId: expert.id } }),
  ]);

  res.status(200).json({
    success: true,
    stats: {
      totalReviewed,
      pendingReview,
      articlesWritten,
      farmersHelped: totalReviewed,
    },
  });
};

export const getExpertArticles = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');
  const expert = await expertFor(userId);

  const articles = await prisma.knowledgeBase.findMany({
    where: { expertId: expert.id },
    orderBy: { updatedAt: 'desc' },
  });

  res.status(200).json({ success: true, articles });
};

export const createArticle = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');
  const expert = await expertFor(userId);

  const { diseaseName, diseaseData, treatmentProtocol, cropType } = req.body as {
    diseaseName?: string;
    diseaseData?: string;
    treatmentProtocol?: string;
    cropType?: string;
  };
  if (!diseaseName || !treatmentProtocol) {
    throw new AppError(
      400,
      'validation_error',
      'Disease name and treatment protocol are required',
      undefined,
      'রোগের নাম ও চিকিৎসার বিবরণ দিন।',
    );
  }

  const article = await prisma.knowledgeBase.create({
    data: {
      diseaseName,
      diseaseData: diseaseData || '',
      treatmentProtocol,
      cropType: cropType || 'General',
      expertId: expert.id,
    },
  });

  res.status(201).json({ success: true, article });
};

/** Public advisory feed. It never exposes farmer or expert contact data. */
export const getAllArticles = async (_req: Request, res: Response): Promise<void> => {
  const articles = await prisma.knowledgeBase.findMany({
    include: {
      expert: { include: { user: { select: { name: true } } } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const mapped = articles.map((article) => ({
    id: article.id,
    diseaseName: article.diseaseName,
    diseaseData: article.diseaseData,
    treatmentProtocol: article.treatmentProtocol,
    cropType: article.cropType,
    expertName: article.expert?.user?.name || 'AgriSense Expert',
    updatedAt: article.updatedAt,
  }));

  res.status(200).json({ success: true, articles: mapped });
};
