import { Response } from 'express';
import prisma from '../config/db';
import { env } from '../config/env';
import { AppError } from '../lib/errors';
import type { AuthRequest } from '../middleware/authMiddleware';
import { fetchWeather } from '../services/weatherService';

/**
 * District defaults to the farmer's own profile location when the query omits
 * it, which is what the app's Weather screen relies on (API_SPEC §5).
 *
 * The location is read from the row rather than the token: `AuthUser` carries
 * only id/role, and widening the token payload to save one lookup would put
 * profile data in a long-lived credential.
 */
async function districtFor(req: AuthRequest): Promise<string> {
  const fromQuery =
    typeof req.query.district === 'string' ? req.query.district.trim() : '';
  if (fromQuery) return fromQuery;

  const userId = req.user?.id;
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { location: true },
    });
    const fromProfile = (user?.location ?? '').trim();
    if (fromProfile) return fromProfile;
  }

  throw new AppError(
    400,
    'district_required',
    'A district is required',
    [{ field: 'district', message: 'A district is required', message_bn: 'জেলা নির্বাচন করুন।' }],
    'জেলা নির্বাচন করুন।',
  );
}

export const getWeather = async (req: AuthRequest, res: Response): Promise<void> => {
  const report = await fetchWeather(await districtFor(req), env.WEATHER_CACHE_MINUTES);
  res.status(200).json({ success: true, weather: report });
};

export const getWeatherAlerts = async (req: AuthRequest, res: Response): Promise<void> => {
  const report = await fetchWeather(await districtFor(req), env.WEATHER_CACHE_MINUTES);
  res.status(200).json({ success: true, alerts: report.alerts, updated_at: report.updated_at });
};
