import { Request, Response } from 'express';
import { AppError } from '../lib/errors';
import { detectRegion, normalizeDialect } from '../services/dialectService';
import { answerVoiceQueryWithRAG } from '../services/ragService';
import { synthesizeSpeech } from '../services/ttsService';

function queryFrom(req: Request): string {
  const value = req.body.query ?? req.body.question ?? req.body.transcript;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(400, 'validation_error', 'Query is required', undefined, 'প্রশ্ন লিখুন।');
  }
  if (value.length > 500) {
    throw new AppError(400, 'validation_error', 'Query is too long', undefined, 'প্রশ্নটি ৫০০ অক্ষরের মধ্যে রাখুন।');
  }
  return value.trim();
}

/**
 * Every voice response carries what the dialect layer did, so the app (and an
 * agronomist reviewing the starter map) can see the normalisation rather than
 * having to guess why a query matched.
 */
function dialectMeta(transcript: string) {
  const normalized = normalizeDialect(transcript);
  const detection = detectRegion(transcript);
  return {
    normalized_text: normalized.text,
    replacements: normalized.replacements,
    dialect_region: detection.region,
    dialect_confidence: detection.confidence,
  };
}

export const askAiHandler = async (req: Request, res: Response): Promise<void> => {
  const query = queryFrom(req);
  const meta = dialectMeta(query);
  // Retrieval runs on the normalised text: dialect spellings are not in the
  // corpus, so searching them directly would miss the protocol.
  const result = await answerVoiceQueryWithRAG(meta.normalized_text);

  res.json({
    success: true,
    transcript: query,
    ...meta,
    found: result.found ?? false,
    answer_text: result.reply,
    reply: result.reply,
    intent: result.intent,
    sources: result.sources ?? [],
    offer_expert: result.offer_expert ?? false,
  });
};

export const interpretVoiceHandler = async (req: Request, res: Response): Promise<void> => {
  const transcript = typeof req.body.transcript === 'string' ? req.body.transcript : '';
  const meta = dialectMeta(transcript);
  const clean = meta.normalized_text.trim().toLowerCase();

  if (!clean) {
    res.json({
      success: true,
      intent: 'unknown',
      transcript: '',
      ...meta,
      confidence: 0,
      found: false,
      offer_expert: false,
    });
    return;
  }

  // Navigation is intentionally deterministic and costs no model call.
  if (clean.includes('বাজার') || clean.includes('হাট') || clean.includes('পণ্য') || clean.includes('দোকান')) {
    res.json({ success: true, intent: 'navigate', destination: 'haat_bazar', confidence: 0.95, transcript, ...meta, found: true, offer_expert: false });
    return;
  }
  if (clean.includes('আবহাওয়া') || clean.includes('বৃষ্টি') || clean.includes('তাপমাত্রা')) {
    res.json({ success: true, intent: 'get_weather', destination: 'weather', confidence: 0.95, transcript, ...meta, found: true, offer_expert: false });
    return;
  }
  if (clean.includes('স্ক্যান') || clean.includes('ছবি') || clean.includes('ক্যামেরা')) {
    res.json({ success: true, intent: 'navigate', destination: 'diagnosis', confidence: 0.95, transcript, ...meta, found: true, offer_expert: false });
    return;
  }
  if (clean.includes('ইতিহাস') || clean.includes('আগের রিপোর্ট')) {
    res.json({ success: true, intent: 'navigate', destination: 'history', confidence: 0.95, transcript, ...meta, found: true, offer_expert: false });
    return;
  }
  if (clean.includes('অর্ডার') || clean.includes('কেনাকাটা')) {
    res.json({ success: true, intent: 'navigate', destination: 'orders', confidence: 0.95, transcript, ...meta, found: true, offer_expert: false });
    return;
  }

  const result = await answerVoiceQueryWithRAG(clean);
  res.json({
    success: true,
    intent: 'ask',
    transcript,
    ...meta,
    confidence: 0.92,
    answer: result.reply,
    found: result.found ?? false,
    sources: result.sources ?? [],
    offer_expert: result.offer_expert ?? false,
  });
};

/** Exposes the dialect layer on its own, so it can be checked without a model call. */
export const normalizeVoiceHandler = async (req: Request, res: Response): Promise<void> => {
  const transcript = typeof req.body.transcript === 'string' ? req.body.transcript : '';
  if (!transcript.trim()) {
    throw new AppError(400, 'validation_error', 'Transcript is required', undefined, 'কথার লেখা দিন।');
  }
  res.json({ success: true, transcript, ...dialectMeta(transcript) });
};

/** Bangla (or English) speech for a line of text, synthesised on the server. */
export const speakVoiceHandler = async (req: Request, res: Response): Promise<void> => {
  const text = req.body.text ?? req.body.reply ?? req.body.answer_text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new AppError(400, 'validation_error', 'Text is required', undefined, 'পড়ার জন্য লেখা দিন।');
  }
  const language = typeof req.body.language === 'string' ? req.body.language : 'bn';
  const speech = await synthesizeSpeech(text, language === 'en' ? 'en-US' : 'bn-BD');
  res.status(200).json({ success: true, ...speech });
};
