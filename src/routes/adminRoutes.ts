import { Router } from 'express';
import {
  listLogs,
  listProducts,
  listUsers,
  listVendors,
  overview,
  rejectVendor,
  resetUserPassword,
  setUserStatus,
  suspendVendor,
  verifyVendor,
} from '../controllers/adminController';
import {
  authenticateToken,
  requireActiveAccount,
  requireRole,
} from '../middleware/authMiddleware';
import { validateBody } from '../middleware/validate';
import {
  adminResetPasswordSchema,
  adminUserStatusSchema,
  reasonSchema,
} from '../validation/admin';

const router = Router();

// Admin routes are never reachable by a pending, suspended or removed account.
router.use(authenticateToken, requireActiveAccount, requireRole('ADMIN'));

router.get('/overview', overview);
router.get('/vendors', listVendors);
router.post('/vendors/:id/verify', verifyVendor);
router.post('/vendors/:id/reject', validateBody(reasonSchema), rejectVendor);
router.post('/vendors/:id/suspend', validateBody(reasonSchema), suspendVendor);
router.get('/users', listUsers);
router.patch('/users/:id/status', validateBody(adminUserStatusSchema), setUserStatus);
// A reissued password is the only recovery path now that the reset flow fails
// closed, so it is an explicit, audited admin action.
router.post(
  '/users/:id/reset-password',
  validateBody(adminResetPasswordSchema),
  resetUserPassword,
);
router.get('/logs', listLogs);
router.get('/products', listProducts);

export default router;
