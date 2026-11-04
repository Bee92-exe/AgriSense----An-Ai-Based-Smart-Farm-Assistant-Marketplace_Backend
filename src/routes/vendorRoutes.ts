import { Router } from 'express';
import {
  addProduct,
  getVendorOrders,
  getVendorProducts,
  getVendorStats,
  updateOrderStatus,
  updateProduct,
} from '../controllers/vendorController';
import { authenticateToken, requireActiveAccount } from '../middleware/authMiddleware';

const router = Router();

// Pending vendors can sign in, but cannot operate a shop until approved.
router.use(authenticateToken, requireActiveAccount);

router.get('/stats', getVendorStats);
router.get('/products', getVendorProducts);
router.post('/products', addProduct);
router.put('/products/:id', updateProduct);
router.get('/orders', getVendorOrders);
router.put('/orders/:id/status', updateOrderStatus);

export default router;
