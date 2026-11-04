import { Router } from 'express';
import {
  listLogs,
  listProducts,
  listUsers,
  listVendors,
  overview,
  rejectVendor,
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
import { adminUserStatusSchema, reasonSchema } from '../validation/admin';

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
router.get('/logs', listLogs);
router.get('/products', listProducts);

export default router;
