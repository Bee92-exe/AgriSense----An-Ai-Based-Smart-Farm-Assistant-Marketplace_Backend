import { Request, Response } from 'express';
import prisma from '../config/db';
import { AuthRequest } from '../middleware/authMiddleware';

// Simulated weather data for Bangladesh districts
const weatherSimulation = () => {
  const conditions = [
    { condition: 'রৌদ্রোজ্জ্বল', iconCode: 'Sunny', tempRange: [30, 36] },
    { condition: 'মেঘলা', iconCode: 'Cloudy', tempRange: [26, 31] },
    { condition: 'বৃষ্টিপাত', iconCode: 'Rainy', tempRange: [24, 29] },
    { condition: 'আংশিক মেঘলা', iconCode: 'Partly Cloudy', tempRange: [28, 33] },
  ];
  const pick = conditions[Math.floor(Math.random() * conditions.length)]!;
  const temp = pick.tempRange[0]! + Math.random() * (pick.tempRange[1]! - pick.tempRange[0]!);
  return {
    temperature: parseFloat(temp.toFixed(1)),
    condition: pick.condition,
    iconCode: pick.iconCode,
    humidity: Math.floor(60 + Math.random() * 30),
    rainfall: parseFloat((Math.random() * 15).toFixed(1)),
    advisory: pick.iconCode === 'Rainy' 
      ? 'আজ বৃষ্টি হতে পারে। ফসল তোলার কাজ পরে করুন।' 
      : 'আজকের আবহাওয়া ফসলের জন্য ভালো।',
  };
};

export const getDashboardSummary = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    // Recent scans for this user
    const recentScans = await prisma.diagnosis.findMany({
      where: { userId },
      orderBy: { timestamp: 'desc' },
      take: 5,
    });

    // Count total scans
    const totalScans = await prisma.diagnosis.count({ where: { userId } });

    // Get user profile
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { farmerProfile: true },
    });

    // Weather simulation
    const weather = weatherSimulation();

    res.status(200).json({
      success: true,
      data: {
        weather,
        stats: {
          totalScans,
          activeCrops: 3, // Simulated
          advisoryPoints: totalScans * 20 + 100,
        },
        recentScans: recentScans.map(s => ({
          id: s.id,
          disease: s.aiDetectedDisease,
          confidence: s.confidenceScore,
          imageUrl: s.imageUrl,
          date: s.timestamp,
        })),
        farmerProfile: user?.farmerProfile || null,
      }
    });
  } catch (error: any) {
    console.error('Dashboard Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load dashboard' });
  }
};
