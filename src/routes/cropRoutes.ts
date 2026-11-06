import { Router } from 'express';
import {
  getCalendar,
  getDistricts,
  getSeasons,
  getSoilTypes,
  recommendCrops,
  savedRecommendations,
} from '../controllers/cropController';
import { authenticateToken, requireActiveAccount } from '../middleware/authMiddleware';

/** `/api/meta` — display strings only, no personalisation. */
export const metaRouter: Router = Router();
metaRouter.use(authenticateToken, requireActiveAccount);
metaRouter.get('/soil-types', getSoilTypes);
metaRouter.get('/seasons', getSeasons);
metaRouter.get('/districts', getDistricts);

/** `/api/crops` and `/api/calendar`. */
export const cropRouter: Router = Router();
cropRouter.use(authenticateToken, requireActiveAccount);
cropRouter.post('/recommend', recommendCrops);
cropRouter.get('/recommendations', savedRecommendations);
cropRouter.get('/calendar', getCalendar);
