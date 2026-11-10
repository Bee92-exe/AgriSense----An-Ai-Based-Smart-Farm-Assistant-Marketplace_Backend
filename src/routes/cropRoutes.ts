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

/**
 * `/api/calendar` — the app calls the calendar at the top level, so it gets its
 * own mount. Keeping it on `cropRouter` as well would have meant
 * `/api/calendar/calendar`, which is exactly the 404 this replaces.
 */
export const calendarRouter: Router = Router();
calendarRouter.use(authenticateToken, requireActiveAccount);
calendarRouter.get('/', getCalendar);
