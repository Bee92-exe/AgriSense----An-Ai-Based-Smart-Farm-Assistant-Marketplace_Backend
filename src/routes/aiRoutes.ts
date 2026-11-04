import { Router } from 'express';
import { askAiHandler } from '../controllers/aiController';

const router = Router();

router.post('/ask', askAiHandler);

export default router;
