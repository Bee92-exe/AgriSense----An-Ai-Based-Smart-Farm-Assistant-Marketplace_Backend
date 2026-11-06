import { Router } from 'express';
import multer from 'multer';
import {
  scanLeaf,
  getDiagnosisHistory,
  getDiagnosisDetail,
  requestReview,
} from '../controllers/diagnosisController';
import { authenticateToken, requireActiveAccount, requireRole } from '../middleware/authMiddleware';

const router = Router();

// Configure multer storage for temporary upload handling
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max upload
  }
});

// Routes
router.post('/scan', authenticateToken, requireActiveAccount, requireRole('FARMER'), upload.single('image'), scanLeaf);
router.get('/history', authenticateToken, requireActiveAccount, requireRole('FARMER'), getDiagnosisHistory);
router.post('/:id/review', authenticateToken, requireActiveAccount, requireRole('FARMER'), requestReview);
router.get('/:id', authenticateToken, requireActiveAccount, requireRole('FARMER'), getDiagnosisDetail);

export default router;
