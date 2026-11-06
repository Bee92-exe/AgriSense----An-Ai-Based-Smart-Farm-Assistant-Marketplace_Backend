import { Router } from 'express';
import { getWeather, getWeatherAlerts } from '../controllers/weatherController';
import { authenticateToken, requireActiveAccount } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticateToken, requireActiveAccount);

router.get('/', getWeather);
router.get('/alerts', getWeatherAlerts);

export default router;
