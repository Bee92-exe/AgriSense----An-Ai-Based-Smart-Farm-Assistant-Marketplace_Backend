import { Router } from 'express';
import { getMyProfile, updateMyProfile } from '../controllers/userController';
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();

// Protect all routes with authentication middleware
router.use(authenticateToken);

router.get('/me', getMyProfile);
router.put('/me', updateMyProfile);

export default router;
