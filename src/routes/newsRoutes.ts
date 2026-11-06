import { Router } from 'express';
import {
  createNews,
  getNews,
  getNewsProducts,
  ingestNews,
  listNews,
  markNewsRead,
} from '../controllers/newsController';
import { authenticateToken, requireActiveAccount, requireRole } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken, requireActiveAccount);

// Authoring and ingest are declared before `/:id` so a literal path is never
// swallowed by the id parameter.
router.post('/ingest', requireRole('ADMIN'), ingestNews);
router.post('/', requireRole('ADMIN', 'EXPERT'), createNews);

router.get('/', listNews);
router.get('/:id/products', getNewsProducts);
router.post('/:id/read', markNewsRead);
router.get('/:id', getNews);

export default router;
