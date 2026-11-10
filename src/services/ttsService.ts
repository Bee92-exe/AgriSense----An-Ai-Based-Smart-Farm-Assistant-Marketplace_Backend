import { env } from '../config/env';
import { AppError } from '../lib/errors';

/**
 * Server-side speech synthesis.
 *
 * Device TTS is not enough for this app: many Android phones in Bangladesh ship
 * with no Bangla voice, so `setLanguage('bn-BD')` silently falls back to an
 * English voice. Synthesising on the server gives every phone the same Bangla
 * female voice.
 *
 * Google Cloud Text-to-Speech needs its own API key — the Gemini key from AI
 * Studio does not authorise this API. Without a key the endpoint returns 503 and
 * the app keeps using the device voice.
 */

const TTS_BASE = 'https://texttospeech.googleapis.com/v1';
/// A full treatment answer (steps, organic and chemical options, precautions)
/// must fit in one request, or the app would need to stitch audio together.
const MAX_CHARS = 1800;
const CACHE_LIMIT = 200;

interface VoiceChoice {
  name: string;
  languageCode: string;
}

const voiceByLanguage = new Map<string, VoiceChoice | null>();
const audioCache = new Map<string, { audio: string; mime: string; voice: string }>();

function apiKey(): string {
  return (env.GOOGLE_TTS_API_KEY ?? '').trim();
}

function unavailable(): AppError {
  return new AppError(
    503,
    'tts_unavailable',
    'Text-to-speech is not configured',
    undefined,
    'কণ্ঠস্বর সেবা এখনো চালু হয়নি।',
  );
}

/**
 * Asks the API which voices exist instead of hard-coding a name, so a renamed or
 * retired voice surfaces as a clear error rather than a silent English fallback.
 */
async function pickVoice(languageCode: string, key: string): Promise<VoiceChoice> {
  const cached = voiceByLanguage.get(languageCode);
  if (cached) return cached;

  const response = await fetch(
    `${TTS_BASE}/voices?languageCode=${encodeURIComponent(languageCode)}&key=${encodeURIComponent(key)}`,
  );
  if (!response.ok) {
    const detail = await response.text();
    console.warn(`[TTS] voice lookup failed (${response.status}): ${detail.slice(0, 200)}`);
    throw unavailable();
  }

  const payload = (await response.json()) as {
    voices?: Array<{ name?: string; languageCodes?: string[]; ssmlGender?: string }>;
  };
  const voices = payload.voices ?? [];
  if (voices.length === 0) {
    console.warn(`[TTS] no voices for ${languageCode}`);
    throw unavailable();
  }

  // Female first: the Bangla voice this app promises is female.
  const chosen = voices.find((voice) => voice.ssmlGender === 'FEMALE') ?? voices[0];
  const choice: VoiceChoice = {
    name: chosen.name ?? '',
    languageCode: chosen.languageCodes?.[0] ?? languageCode,
  };
  voiceByLanguage.set(languageCode, choice);
  return choice;
}

export interface SynthesizedSpeech {
  audio_base64: string;
  mime_type: string;
  voice: string;
  language: string;
  cached: boolean;
}

export async function synthesizeSpeech(
  text: string,
  languageCode = 'bn-BD',
): Promise<SynthesizedSpeech> {
  const key = apiKey();
  if (!key) throw unavailable();

  const clean = text.trim();
  if (!clean) {
    throw new AppError(400, 'validation_error', 'Text is required', undefined, 'পড়ার জন্য লেখা দিন।');
  }
  if (clean.length > MAX_CHARS) {
    throw new AppError(
      400,
      'validation_error',
      `Text must be at most ${MAX_CHARS} characters`,
      undefined,
      `লেখাটি ${MAX_CHARS} অক্ষরের মধ্যে রাখুন।`,
    );
  }

  const language = languageCode.startsWith('en') ? 'en-US' : 'bn-BD';
  const cacheKey = `${language}\u0000${clean}`;
  const hit = audioCache.get(cacheKey);
  if (hit) {
    return {
      audio_base64: hit.audio,
      mime_type: hit.mime,
      voice: hit.voice,
      language,
      cached: true,
    };
  }

  const voice = await pickVoice(language, key);
  const response = await fetch(`${TTS_BASE}/text:synthesize?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text: clean },
      voice: { languageCode: voice.languageCode, name: voice.name },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 0.95, pitch: 0 },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.warn(`[TTS] synthesis failed (${response.status}): ${detail.slice(0, 200)}`);
    throw unavailable();
  }

  const payload = (await response.json()) as { audioContent?: string };
  if (!payload.audioContent) {
    console.warn('[TTS] response had no audioContent');
    throw unavailable();
  }

  const result = { audio: payload.audioContent, mime: 'audio/mpeg', voice: voice.name };
  audioCache.set(cacheKey, result);
  if (audioCache.size > CACHE_LIMIT) {
    const oldest = audioCache.keys().next().value;
    if (oldest !== undefined) audioCache.delete(oldest);
  }

  return {
    audio_base64: result.audio,
    mime_type: result.mime,
    voice: result.voice,
    language,
    cached: false,
  };
}
