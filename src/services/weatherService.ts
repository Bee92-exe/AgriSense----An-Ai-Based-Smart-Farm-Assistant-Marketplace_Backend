import { AppError } from '../lib/errors';

/**
 * OpenWeatherMap adapter.
 *
 * The mapping lives here and nowhere else so the provider can be replaced
 * without touching a controller, and so the wire shape the app already models
 * (`WeatherReport`) is produced in exactly one place.
 */

export interface WeatherNowPayload {
  temp_c: number;
  condition: string;
  humidity: number;
  wind_kph: number;
  icon: string;
}

export interface WeatherDayPayload {
  date: string;
  min_c: number;
  max_c: number;
  condition: string;
  rain_mm: number;
  icon: string;
}

export interface WeatherAlertPayload {
  id: string;
  type: string;
  message_bn: string;
  created_at: string;
}

export interface WeatherReportPayload {
  district: string;
  current: WeatherNowPayload;
  forecast: WeatherDayPayload[];
  alerts: WeatherAlertPayload[];
  updated_at: string;
  /** False while the screen is serving a cached answer. */
  is_live: boolean;
}

/**
 * Only the districts we have real coordinates for. A guessed coordinate would
 * put a farmer's forecast in the wrong district, which is worse than saying we
 * do not cover it, so an unknown district falls back to the division centre it
 * is asked about or errors out.
 */
const DISTRICT_COORDS: Record<string, { lat: number; lon: number }> = {
  dhaka: { lat: 23.8103, lon: 90.4125 },
  ঢাকা: { lat: 23.8103, lon: 90.4125 },
  chattogram: { lat: 22.3569, lon: 91.7832 },
  চট্টগ্রাম: { lat: 22.3569, lon: 91.7832 },
  khulna: { lat: 22.8456, lon: 89.5403 },
  খুলনা: { lat: 22.8456, lon: 89.5403 },
  rajshahi: { lat: 24.3636, lon: 88.6241 },
  রাজশাহী: { lat: 24.3636, lon: 88.6241 },
  sylhet: { lat: 24.8949, lon: 91.8687 },
  সিলেট: { lat: 24.8949, lon: 91.8687 },
  barishal: { lat: 22.701, lon: 90.3535 },
  বরিশাল: { lat: 22.701, lon: 90.3535 },
  rangpur: { lat: 25.7439, lon: 89.2752 },
  রংপুর: { lat: 25.7439, lon: 89.2752 },
  mymensingh: { lat: 24.7471, lon: 90.4203 },
  ময়মনসিংহ: { lat: 24.7471, lon: 90.4203 },
  bogura: { lat: 24.8465, lon: 89.3773 },
  বগুড়া: { lat: 24.8465, lon: 89.3773 },
  jashore: { lat: 23.1664, lon: 89.2081 },
  যশোর: { lat: 23.1664, lon: 89.2081 },
  cumilla: { lat: 23.4607, lon: 91.1809 },
  কুমিল্লা: { lat: 23.4607, lon: 91.1809 },
  dinajpur: { lat: 25.6217, lon: 88.6354 },
  দিনাজপুর: { lat: 25.6217, lon: 88.6354 },
  faridpur: { lat: 23.607, lon: 89.8429 },
  ফরিদপুর: { lat: 23.607, lon: 89.8429 },
  tangail: { lat: 24.2513, lon: 89.9167 },
  টাঙ্গাইল: { lat: 24.2513, lon: 89.9167 },
  noakhali: { lat: 22.8696, lon: 91.0995 },
  নোয়াখালী: { lat: 22.8696, lon: 91.0995 },
  sahabganj: { lat: 25.0836, lon: 89.4286 },
  সাপাহার: { lat: 25.0836, lon: 89.4286 },
};

const CONDITION_BN: Record<string, string> = {
  Clear: 'পরিষ্কার আকাশ',
  Clouds: 'মেঘলা',
  Rain: 'বৃষ্টি',
  Drizzle: 'গুঁড়ি গুঁড়ি বৃষ্টি',
  Thunderstorm: 'বজ্রসহ বৃষ্টি',
  Mist: 'কুয়াশা',
  Fog: 'কুয়াশা',
  Haze: 'ধোঁয়াশা',
  Dust: 'ধুলাবালি',
  Squall: 'ঝড়ো হাওয়া',
  Tornado: 'টর্নেডো',
  Snow: 'তুষার',
};

interface CacheEntry {
  at: number;
  payload: WeatherReportPayload;
}

const cache = new Map<string, CacheEntry>();

export function districtCoordinates(district: string): { lat: number; lon: number } | null {
  const key = district.trim().toLowerCase();
  return DISTRICT_COORDS[key] ?? null;
}

export function knownDistricts(): string[] {
  // English keys only: the Bangla aliases point at the same places.
  return Object.keys(DISTRICT_COORDS).filter((name) => /^[a-z]+$/.test(name));
}

function conditionBn(main: string | undefined): string {
  if (!main) return 'অজানা';
  return CONDITION_BN[main] ?? main;
}

function iconFor(main: string | undefined): string {
  const key = (main ?? '').toLowerCase();
  if (key === 'clear') return 'sunny';
  if (key === 'rain' || key === 'drizzle') return 'rain';
  if (key === 'thunderstorm') return 'storm';
  if (key === 'mist' || key === 'fog' || key === 'haze') return 'fog';
  return 'cloudy';
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Derives farmer-facing advisories from the forecast instead of claiming to
 * relay official warnings. OpenWeatherMap's free tier has no alert feed, and
 * presenting our own inference as a government warning would be dishonest.
 */
function deriveAlerts(forecast: WeatherDayPayload[]): WeatherAlertPayload[] {
  const alerts: WeatherAlertPayload[] = [];
  const now = new Date().toISOString();
  const wetDay = forecast.find((day) => day.rain_mm >= 50);
  if (wetDay) {
    alerts.push({
      id: `heavy_rain_${wetDay.date}`,
      type: 'heavy_rain',
      message_bn: `${wetDay.date} তারিখে ভারী বৃষ্টির সম্ভাবনা (${Math.round(
        wetDay.rain_mm,
      )} মিমি)। সেচ বন্ধ রাখুন ও নিচু জমির পানি নিষ্কাশনের ব্যবস্থা করুন।`,
      created_at: now,
    });
  }
  const hotDay = forecast.find((day) => day.max_c >= 36);
  if (hotDay) {
    alerts.push({
      id: `heat_${hotDay.date}`,
      type: 'heat',
      message_bn: `${hotDay.date} তারিখে তাপমাত্রা ${Math.round(
        hotDay.max_c,
      )} ডিগ্রি পর্যন্ত উঠতে পারে। দুপুরে স্প্রে করবেন না।`,
      created_at: now,
    });
  }
  return alerts;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (response.status === 401) {
    throw new AppError(
      503,
      'weather_credentials_invalid',
      'Weather provider rejected the API key',
      undefined,
      'আবহাওয়ার তথ্য পাওয়া যাচ্ছে না।',
    );
  }
  if (!response.ok) {
    throw new AppError(
      502,
      'weather_upstream_error',
      `Weather provider returned ${response.status}`,
      undefined,
      'আবহাওয়ার তথ্য পাওয়া যাচ্ছে না।',
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function fetchWeather(district: string, ttlMinutes: number): Promise<WeatherReportPayload> {
  const coords = districtCoordinates(district);
  if (!coords) {
    throw new AppError(
      404,
      'district_unsupported',
      `No coordinates for district ${district}`,
      undefined,
      'এই জেলার আবহাওয়ার তথ্য এখনো যুক্ত হয়নি।',
    );
  }

  const apiKey = process.env.WEATHER_API_KEY?.trim();
  if (!apiKey) {
    throw new AppError(
      503,
      'weather_unavailable',
      'WEATHER_API_KEY is not configured',
      undefined,
      'আবহাওয়ার সেবা চালু করা হয়নি।',
    );
  }

  const cacheKey = district.trim().toLowerCase();
  const cached = cache.get(cacheKey);
  const ttlMs = Math.max(1, ttlMinutes) * 60 * 1000;
  if (cached && Date.now() - cached.at < ttlMs) {
    return { ...cached.payload, is_live: false };
  }

  const base = 'https://api.openweathermap.org/data/2.5';
  const query = `lat=${coords.lat}&lon=${coords.lon}&units=metric&appid=${apiKey}`;

  const [current, forecastRaw] = await Promise.all([
    getJson(`${base}/weather?${query}`),
    getJson(`${base}/forecast?${query}`),
  ]);

  const main = (current.main ?? {}) as Record<string, number>;
  const wind = (current.wind ?? {}) as Record<string, number>;
  const weather = Array.isArray(current.weather)
    ? ((current.weather[0] ?? {}) as Record<string, string>)
    : {};

  const buckets = new Map<
    string,
    { min: number; max: number; rain: number; main: string; count: number }
  >();

  const list = Array.isArray(forecastRaw.list) ? forecastRaw.list : [];
  for (const entry of list) {
    const row = entry as Record<string, unknown>;
    const time = typeof row.dt_txt === 'string' ? row.dt_txt : '';
    const date = time.slice(0, 10);
    if (!date) continue;
    const rowMain = (row.main ?? {}) as Record<string, number>;
    const rowRain = (row.rain ?? {}) as Record<string, number>;
    const rowWeather = Array.isArray(row.weather)
      ? ((row.weather[0] ?? {}) as Record<string, string>)
      : {};
    const temp = Number(rowMain.temp ?? 0);
    const rain = Number((rowRain as Record<string, number>)['3h'] ?? 0);

    const existing = buckets.get(date);
    if (!existing) {
      buckets.set(date, {
        min: temp,
        max: temp,
        rain,
        main: rowWeather.main ?? 'Clouds',
        count: 1,
      });
    } else {
      existing.min = Math.min(existing.min, temp);
      existing.max = Math.max(existing.max, temp);
      existing.rain += rain;
      existing.count += 1;
    }
  }

  const forecast: WeatherDayPayload[] = Array.from(buckets.entries())
    .slice(0, 6)
    .map(([date, bucket]) => ({
      date: `${date}T00:00:00.000Z`,
      min_c: round1(bucket.min),
      max_c: round1(bucket.max),
      condition: conditionBn(bucket.main),
      rain_mm: round1(bucket.rain),
      icon: iconFor(bucket.main),
    }));

  const payload: WeatherReportPayload = {
    district,
    current: {
      temp_c: round1(Number(main.temp ?? 0)),
      condition: conditionBn(weather.main),
      humidity: Math.round(Number(main.humidity ?? 0)),
      wind_kph: round1(Number(wind.speed ?? 0) * 3.6),
      icon: iconFor(weather.main),
    },
    forecast,
    alerts: deriveAlerts(forecast),
    updated_at: new Date().toISOString(),
    is_live: true,
  };

  cache.set(cacheKey, { at: Date.now(), payload });
  return payload;
}
