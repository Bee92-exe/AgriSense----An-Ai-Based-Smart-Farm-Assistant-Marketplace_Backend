import { Router } from 'express';
import {
  createArticle,
  getAllArticles,
  getExpertArticles,
  getExpertStats,
  getPendingDiagnoses,
  reviewDiagnosis,
} from '../controllers/expertController';
import { authenticateToken, requireActiveAccount } from '../middleware/authMiddleware';

const router = Router();

router.get('/articles/public', getAllArticles); // Public feed for the advisory screen

// Pending experts can sign in, but cannot review cases until approved.
router.get('/stats', authenticateToken, requireActiveAccount, getExpertStats);
router.get('/diagnoses/pending', authenticateToken, requireActiveAccount, getPendingDiagnoses);
router.put('/diagnoses/:id/review', authenticateToken, requireActiveAccount, reviewDiagnosis);
router.get('/articles', authenticateToken, requireActiveAccount, getExpertArticles);
router.post('/articles', authenticateToken, requireActiveAccount, createArticle);

export default router;
