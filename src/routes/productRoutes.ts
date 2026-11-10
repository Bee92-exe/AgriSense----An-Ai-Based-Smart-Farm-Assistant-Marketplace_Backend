import { Router } from 'express';
import {
  getAllProducts,
  getMatchedProducts,
  getProductById,
  getProductCategories,
} from '../controllers/productController';
import { authenticateToken, requireActiveAccount } from '../middleware/authMiddleware';

const router = Router();

// Literal paths are declared before `/:id`, otherwise `/categories` would be
// read as a product id.
router.get('/categories', getProductCategories);
router.get('/matched/:diagnosisId', authenticateToken, requireActiveAccount, getMatchedProducts);
router.get('/', getAllProducts);
router.get('/:id', getProductById);

export default router;
