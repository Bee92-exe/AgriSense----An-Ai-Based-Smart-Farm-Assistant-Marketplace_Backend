import { Request, Response } from 'express';
import prisma from '../config/db';
import { AuthRequest } from '../middleware/authMiddleware';

// Get pending diagnoses for expert review
export const getPendingDiagnoses = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const diagnoses = await prisma.diagnosis.findMany({
      where: { expertReview: null },
      include: {
        user: { select: { name: true, location: true } },
      },
      orderBy: { timestamp: 'desc' },
      take: 20,
    });

    const mapped = diagnoses.map(d => ({
      id: d.id,
      disease: d.aiDetectedDisease,
      confidence: d.confidenceScore,
      imageUrl: d.imageUrl,
      date: d.timestamp,
      farmerName: d.user?.name || 'Unknown',
      farmerLocation: d.user?.location || '',
      hasImage: !!d.imageUrl,
    }));

    res.status(200).json({ success: true, diagnoses: mapped });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch diagnoses' });
  }
};

// Submit expert review for a diagnosis
export const reviewDiagnosis = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

    const diagnosisId = req.params.id as string;
    const { review } = req.body;

    const expert = await prisma.expert.findUnique({ where: { userId } });
    if (!expert) { res.status(403).json({ success: false, message: 'Not an expert' }); return; }

    const diagnosis = await prisma.diagnosis.update({
      where: { id: diagnosisId },
      data: {
        expertReview: review,
        expertId: expert.id,
        status: 'COMPLETED',
      },
    });

    res.status(200).json({ success: true, diagnosis });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to submit review' });
  }
};

// Get expert dashboard stats
export const getExpertStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

    const expert = await prisma.expert.findUnique({ where: { userId } });
    if (!expert) { res.status(403).json({ success: false, message: 'Not an expert' }); return; }

    const totalReviewed = await prisma.diagnosis.count({ where: { expertId: expert.id } });
    const pendingReview = await prisma.diagnosis.count({ where: { expertReview: null } });
    const articlesWritten = await prisma.knowledgeBase.count({ where: { expertId: expert.id } });

    res.status(200).json({
      success: true,
      stats: {
        totalReviewed,
        pendingReview,
        articlesWritten,
        farmersHelped: totalReviewed, // 1:1 mapping for now
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch expert stats' });
  }
};

// Get articles by this expert
export const getExpertArticles = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

    const expert = await prisma.expert.findUnique({ where: { userId } });
    if (!expert) { res.status(403).json({ success: false, message: 'Not an expert' }); return; }

    const articles = await prisma.knowledgeBase.findMany({
      where: { expertId: expert.id },
      orderBy: { updatedAt: 'desc' },
    });

    res.status(200).json({ success: true, articles });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch articles' });
  }
};

// Create a new article
export const createArticle = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

    const expert = await prisma.expert.findUnique({ where: { userId } });
    if (!expert) { res.status(403).json({ success: false, message: 'Not an expert' }); return; }

    const { diseaseName, diseaseData, treatmentProtocol, cropType } = req.body;

    const article = await prisma.knowledgeBase.create({
      data: {
        diseaseName,
        diseaseData: diseaseData || '',
        treatmentProtocol: treatmentProtocol || '',
        cropType: cropType || 'General',
        expertId: expert.id,
      }
    });

    res.status(201).json({ success: true, article });
  } catch (error: any) {
    console.error('Article Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to create article' });
  }
};

// Get all articles for public advisory feed
export const getAllArticles = async (req: Request, res: Response): Promise<void> => {
  try {
    const articles = await prisma.knowledgeBase.findMany({
      include: {
        expert: {
          include: { user: { select: { name: true } } }
        }
      },
      orderBy: { updatedAt: 'desc' },
    });

    const mapped = articles.map(a => ({
      id: a.id,
      diseaseName: a.diseaseName,
      diseaseData: a.diseaseData,
      treatmentProtocol: a.treatmentProtocol,
      cropType: a.cropType,
      expertName: a.expert?.user?.name || 'AgriSense Expert',
      updatedAt: a.updatedAt,
    }));

    res.status(200).json({ success: true, articles: mapped });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch articles' });
  }
};
