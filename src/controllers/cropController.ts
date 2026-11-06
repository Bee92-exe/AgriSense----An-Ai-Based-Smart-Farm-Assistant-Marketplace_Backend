import { Response } from 'express';
import { AppError } from '../lib/errors';
import type { AuthRequest } from '../middleware/authMiddleware';
import { knownDistricts } from '../services/weatherService';

/**
 * Reference data and crop advice.
 *
 * The ranking is a transparent rule table, not a model: it is auditable, it
 * never invents a reason, and `weather_included` is reported honestly as false
 * because the ranking does not read the forecast yet.
 */

const SOIL_TYPES = ['দোআঁশ', 'এঁটেল', 'বালু', 'পলি', 'লবণাক্ত'];
const SEASONS = ['রবি', 'খরিফ-১', 'খরিফ-২'];

const DISTRICT_LABELS: Record<string, string> = {
  dhaka: 'ঢাকা',
  chattogram: 'চট্টগ্রাম',
  khulna: 'খুলনা',
  rajshahi: 'রাজশাহী',
  sylhet: 'সিলেট',
  barishal: 'বরিশাল',
  rangpur: 'রংপুর',
  mymensingh: 'ময়মনসিংহ',
  bogura: 'বগুড়া',
  jashore: 'যশোর',
  cumilla: 'কুমিল্লা',
  dinajpur: 'দিনাজপুর',
  faridpur: 'ফরিদপুর',
  tangail: 'টাঙ্গাইল',
  noakhali: 'নোয়াখালী',
  sahabganj: 'সাপাহার',
};

interface Ranked {
  crop: string;
  base: number;
  reason: string;
}

/// Only the three crops the app models (`CropType` in enums.dart). Anything else
/// would be parsed back as Rice on the device, so the server never offers it.
const BY_SEASON: Record<string, Ranked[]> = {
  রবি: [
    { crop: 'potato', base: 0.9, reason: 'শীতের কম তাপমাত্রা ও কুয়াশা আলুর অঙ্কুরোদগমের জন্য উপযোগী।' },
    { crop: 'tomato', base: 0.78, reason: 'শীতকালে টমেটোতে রোগ কম হয়, দামও ভালো পাওয়া যায়।' },
    { crop: 'rice', base: 0.6, reason: 'বোরো ধানের জন্য শীতকাল সেচ ও পরিচর্যা বেশি লাগে।' },
  ],
  'খরিফ-১': [
    { crop: 'rice', base: 0.88, reason: 'খরিফ-১ মৌসুমে বোরো ধানের প্রধান চাষ সময়।' },
    { crop: 'tomato', base: 0.55, reason: 'গরমে টমেটোতে পোকা ও ভাইরাসের ঝুঁকি বেশি।' },
    { crop: 'potato', base: 0.4, reason: 'গরমে আলুর বীজ বপন ভালো ফল দেয় না।' },
  ],
  'খরিফ-২': [
    { crop: 'rice', base: 0.9, reason: 'বর্ষায় আমন ধান সবচেয়ে বেশি চাষ হয়।' },
    { crop: 'tomato', base: 0.62, reason: 'বর্ষায় টমেটোর চারা ভালো হয়, তবে পানি নিষ্কাশন দরকার।' },
    { crop: 'potato', base: 0.35, reason: 'বর্ষায় আলুতে নাবি ধসার ঝুঁকি খুব বেশি।' },
  ],
};

/** Small, explicit soil adjustments — enough to change the order, not to fake precision. */
const SOIL_BIAS: Record<string, Record<string, number>> = {
  'দোআঁশ': { rice: 0.03, potato: 0.03, tomato: 0.02 },
  এঁটেল: { rice: 0.04, potato: -0.03 },
  বালু: { potato: 0.02, rice: -0.05 },
  পলি: { rice: 0.04, tomato: 0.01 },
  লবণাক্ত: { rice: 0.01, potato: -0.06, tomato: -0.05 },
};

export const getSoilTypes = (_req: AuthRequest, res: Response): void => {
  res.status(200).json({ success: true, soil_types: SOIL_TYPES });
};

export const getSeasons = (_req: AuthRequest, res: Response): void => {
  res.status(200).json({ success: true, seasons: SEASONS });
};

export const getDistricts = (_req: AuthRequest, res: Response): void => {
  const districts = knownDistricts().map((key) => DISTRICT_LABELS[key] ?? key);
  res.status(200).json({ success: true, districts });
};

export const recommendCrops = (req: AuthRequest, res: Response): void => {
  const { district, soil_type: soilType, season } = req.body as Record<string, string | undefined>;
  const chosenSeason = (season ?? '').trim();
  const chosenSoil = (soilType ?? '').trim();

  if (!district || !chosenSoil || !chosenSeason) {
    throw new AppError(
      400,
      'validation_error',
      'district, soil_type and season are required',
      undefined,
      'জেলা, মাটির ধরন ও মৌসুম নির্বাচন করুন।',
    );
  }
  if (!SEASONS.includes(chosenSeason)) {
    throw new AppError(
      400,
      'validation_error',
      'Unknown season',
      [{ field: 'season', message: 'Unknown season', message_bn: 'মৌসুম সঠিক নয়।' }],
      'মৌসুম সঠিক নয়।',
    );
  }

  const table = BY_SEASON[chosenSeason] ?? [];
  const bias = SOIL_BIAS[chosenSoil] ?? {};

  const results = table
    .map((entry) => ({
      crop: entry.crop,
      score: Math.max(0, Math.min(1, entry.base + (bias[entry.crop] ?? 0))),
      reason_bn: `${entry.reason} ${chosenSoil} মাটি ও ${chosenSeason} মৌসুম বিবেচনায় রাখা হয়েছে।`,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry, index) => ({
      rank: index + 1,
      crop: entry.crop,
      reason_bn: entry.reason_bn,
      score: Math.round(entry.score * 100) / 100,
    }));

  res.status(200).json({
    success: true,
    advice: {
      id: `local_${Date.now()}`,
      // Honest: the rule table does not read the forecast yet.
      weather_included: false,
      results,
      district,
      soil_type: chosenSoil,
      season: chosenSeason,
      created_at: new Date().toISOString(),
    },
  });
};

/**
 * History is not persisted yet — `shortcut: no recommendation history table,
 * upgrade when the profile screen needs past answers`.
 */
export const savedRecommendations = (_req: AuthRequest, res: Response): void => {
  res.status(200).json({ success: true, recommendations: [] });
};

const CALENDARS: Record<string, Array<{ activity: string; start_month: number; end_month: number; note_bn: string }>> = {
  rice: [
    { activity: 'planting', start_month: 6, end_month: 8, note_bn: 'আমন ধানের রোপণ সময়।' },
    { activity: 'harvest', start_month: 11, end_month: 12, note_bn: 'আমন ধান কাটার সময়।' },
    { activity: 'planting', start_month: 11, end_month: 1, note_bn: 'বোরো ধানের বীজতলা ও রোপণ।' },
    { activity: 'harvest', start_month: 4, end_month: 5, note_bn: 'বোরো ধান কাটার সময়।' },
  ],
  potato: [
    { activity: 'planting', start_month: 11, end_month: 12, note_bn: 'আলু বপনের প্রধান সময়।' },
    { activity: 'harvest', start_month: 2, end_month: 3, note_bn: 'আলু তোলার সময়।' },
  ],
  tomato: [
    { activity: 'planting', start_month: 9, end_month: 11, note_bn: 'টমেটোর চারা রোপণ।' },
    { activity: 'harvest', start_month: 1, end_month: 3, note_bn: 'টমেটো তোলার সময়।' },
  ],
};

export const getCalendar = (req: AuthRequest, res: Response): void => {
  const crop = (typeof req.query.crop === 'string' ? req.query.crop : '').trim().toLowerCase();
  const windows = CALENDARS[crop];
  if (!windows) {
    throw new AppError(
      404,
      'not_found',
      `No calendar for crop ${crop}`,
      undefined,
      'এই ফসলের ক্যালেন্ডার এখনো যুক্ত হয়নি।',
    );
  }
  res.status(200).json({ success: true, calendar: { crop, windows } });
};
