import { Router } from 'express';
import {
  createArticle,
  getAllArticles,
  getExpertArticles,
  getExpertStats,
  getPendingDiagnoses,
  needsRetake,
  reviewDiagnosis,
} from '../controllers/expertController';
import { authenticateToken, requireActiveAccount, requireRole } from '../middleware/authMiddleware';

const router = Router();

router.get('/articles/public', getAllArticles); // Public feed for the advisory screen

router.use(authenticateToken, requireActiveAccount, requireRole('EXPERT'));

router.get('/stats', getExpertStats);
router.get('/diagnoses/pending', getPendingDiagnoses);
router.put('/diagnoses/:id/review', reviewDiagnosis);
router.post('/diagnoses/:id/needs-retake', needsRetake);
router.get('/articles', getExpertArticles);
router.post('/articles', createArticle);

export default router;
