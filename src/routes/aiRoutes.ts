import { Router } from 'express';
import { askAiHandler, interpretVoiceHandler } from '../controllers/aiController';
import { authenticateToken, requireActiveAccount, requireRole } from '../middleware/authMiddleware';
import { aiLimiter } from '../middleware/rateLimit';

const router = Router();

// AI calls cost real Gemini credits and must never be anonymous.
router.use(authenticateToken, requireActiveAccount, requireRole('FARMER'), aiLimiter);

router.post('/ask', askAiHandler);
router.post('/interpret', interpretVoiceHandler);

export default router;
