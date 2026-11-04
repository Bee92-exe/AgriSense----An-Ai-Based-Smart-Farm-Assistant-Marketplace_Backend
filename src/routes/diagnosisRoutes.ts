import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { scanLeaf } from '../controllers/diagnosisController';
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// Routes
router.post('/scan', authenticateToken, upload.single('image'), scanLeaf);

export default router;
