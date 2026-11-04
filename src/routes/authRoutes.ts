import { Router } from 'express';
import {
  changePassword,
  forgotPassword,
  login,
  logout,
  refresh,
  register,
  resetPassword,
} from '../controllers/authController';
import { authenticateToken } from '../middleware/authMiddleware';
import { authLimiter, loginLimiter, sensitiveLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validate';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
} from '../validation/auth';

const router = Router();

router.post('/register', authLimiter, validateBody(registerSchema), register);
router.post('/login', loginLimiter, validateBody(loginSchema), login);
router.post('/refresh', authLimiter, validateBody(refreshSchema), refresh);
router.post('/logout', authLimiter, validateBody(refreshSchema), logout);

router.post(
  '/password/change',
  authenticateToken,
  validateBody(changePasswordSchema),
  changePassword,
);
router.post('/password/forgot', sensitiveLimiter, validateBody(forgotPasswordSchema), forgotPassword);
router.post('/password/reset', sensitiveLimiter, validateBody(resetPasswordSchema), resetPassword);

export default router;
