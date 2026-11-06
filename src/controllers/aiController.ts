import { Request, Response } from 'express';
import { AppError } from '../lib/errors';
import { answerVoiceQueryWithRAG } from '../services/ragService';

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

export const askAiHandler = async (req: Request, res: Response): Promise<void> => {
  const query = queryFrom(req);
  const result = await answerVoiceQueryWithRAG(query);

  res.json({
    success: true,
    transcript: query,
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
  const clean = transcript.trim().toLowerCase();

  if (!clean) {
    res.json({
      success: true,
      intent: 'unknown',
      transcript: '',
      confidence: 0,
      found: false,
      offer_expert: false,
    });
    return;
  }

  // Navigation is intentionally deterministic and costs no model call.
  if (clean.includes('বাজার') || clean.includes('হাট') || clean.includes('পণ্য') || clean.includes('দোকান')) {
    res.json({ success: true, intent: 'navigate', destination: 'haat_bazar', confidence: 0.95, transcript, found: true, offer_expert: false });
    return;
  }
  if (clean.includes('আবহাওয়া') || clean.includes('বৃষ্টি') || clean.includes('তাপমাত্রা')) {
    res.json({ success: true, intent: 'get_weather', destination: 'weather', confidence: 0.95, transcript, found: true, offer_expert: false });
    return;
  }
  if (clean.includes('স্ক্যান') || clean.includes('ছবি') || clean.includes('ক্যামেরা')) {
    res.json({ success: true, intent: 'navigate', destination: 'diagnosis', confidence: 0.95, transcript, found: true, offer_expert: false });
    return;
  }
  if (clean.includes('ইতিহাস') || clean.includes('আগের রিপোর্ট')) {
    res.json({ success: true, intent: 'navigate', destination: 'history', confidence: 0.95, transcript, found: true, offer_expert: false });
    return;
  }
  if (clean.includes('অর্ডার') || clean.includes('কেনাকাটা')) {
    res.json({ success: true, intent: 'navigate', destination: 'orders', confidence: 0.95, transcript, found: true, offer_expert: false });
    return;
  }

  const result = await answerVoiceQueryWithRAG(transcript);
  res.json({
    success: true,
    intent: 'ask',
    transcript,
    confidence: 0.92,
    answer: result.reply,
    found: result.found ?? false,
    sources: result.sources ?? [],
    offer_expert: result.offer_expert ?? false,
  });
};

