import { Router } from 'express';
import {
  addProduct,
  deleteProduct,
  getVendorBusiness,
  getVendorDesk,
  getVendorOrders,
  getVendorProducts,
  getVendorStats,
  recordVendorVisit,
  saveCustomerNote,
  setFollowUp,
  updateOrderStatus,
  updateProduct,
} from '../controllers/vendorController';
import { authenticateToken, requireActiveAccount, requireRole } from '../middleware/authMiddleware';

/** `/api/vendor` — the signed-in shop's own console. */
const router = Router();

// Pending vendors can sign in, but cannot operate a shop until approved. The
// role gate is here as well as in the controllers: without it any authenticated
// account reached these handlers and only some of them re-checked.
router.use(authenticateToken, requireActiveAccount, requireRole('VENDOR'));

router.get('/desk', getVendorDesk);
router.get('/stats', getVendorStats);
router.get('/business', getVendorBusiness);

router.get('/products', getVendorProducts);
router.post('/products', addProduct);
router.put('/products/:id', updateProduct);
router.delete('/products/:id', deleteProduct);

router.get('/orders', getVendorOrders);
router.put('/orders/:id/status', updateOrderStatus);

router.put('/customers/:customerId/note', saveCustomerNote);
router.put('/customers/:customerId/follow-up', setFollowUp);

/** `/api/vendors` — farmer-facing, so it must not sit behind the vendor gate. */
export const publicVendorRouter: Router = Router();
publicVendorRouter.use(authenticateToken, requireActiveAccount);
publicVendorRouter.post('/:id/visit', recordVendorVisit);

export default router;
