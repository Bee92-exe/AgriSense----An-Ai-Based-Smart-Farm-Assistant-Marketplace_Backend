import { Router } from 'express';
import {
  cancelOrder,
  createOrder,
  getInvoice,
  getMyOrders,
  getOrder,
  rateVendor,
} from '../controllers/orderController';
import { authenticateToken, requireActiveAccount, requireRole } from '../middleware/authMiddleware';

export const orderRouter: Router = Router();
orderRouter.use(authenticateToken, requireActiveAccount);

orderRouter.get('/', getMyOrders);
orderRouter.post('/', requireRole('FARMER'), createOrder);
orderRouter.get('/:id', getOrder);
orderRouter.post('/:id/cancel', requireRole('FARMER'), cancelOrder);
orderRouter.get('/:id/invoice', getInvoice);

/** `/api/vendors/:id/rating` — FR-26, farmer rates the seller after an order. */
export const vendorRatingRouter: Router = Router();
vendorRatingRouter.use(authenticateToken, requireActiveAccount);
vendorRatingRouter.post('/:id/rating', requireRole('FARMER'), rateVendor);
