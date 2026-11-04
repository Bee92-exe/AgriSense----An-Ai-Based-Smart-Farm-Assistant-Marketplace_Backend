import { Router } from 'express';
import { getAllProducts, getProductById, createOrder, getMyOrders } from '../controllers/productController';
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();

router.get('/', getAllProducts);
router.get('/:id', getProductById);
router.post('/order', authenticateToken, createOrder);
router.get('/orders/mine', authenticateToken, getMyOrders);

export default router;
