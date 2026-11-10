import { Router } from 'express';
import {
  askAiHandler,
  interpretVoiceHandler,
  normalizeVoiceHandler,
  speakVoiceHandler,
} from '../controllers/aiController';
import { authenticateToken, requireActiveAccount, requireRole } from '../middleware/authMiddleware';
import { aiLimiter } from '../middleware/rateLimit';

const router = Router();

// AI calls cost real Gemini/TTS credits and must never be anonymous.
router.use(authenticateToken, requireActiveAccount, requireRole('FARMER'), aiLimiter);

router.post('/ask', askAiHandler);
router.post('/interpret', interpretVoiceHandler);
router.post('/normalize', normalizeVoiceHandler);
router.post('/tts', speakVoiceHandler);

export default router;
