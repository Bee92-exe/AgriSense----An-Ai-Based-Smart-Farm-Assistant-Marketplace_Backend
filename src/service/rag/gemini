import { GoogleGenerativeAI } from '@google/generative-ai';
import type { GenerationConfig, Part } from '@google/generative-ai';
import { env } from '../../config/env';

export const VISION_MODEL = 'gemini-3.5-flash';
const EMBEDDING_MODEL = 'gemini-embedding-2';
const EMBEDDING_DIMENSIONS = 768;
const REQUEST_TIMEOUT_MS = 30_000;

function getGeminiKey(): string {
  return (env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

export function requireGeminiKey(): string {
  const key = getGeminiKey();
  if (!key) throw new Error('Missing GEMINI_API_KEY');
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b(429|500|502|503|504)\b/.test(message) ||
    /timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message)
  );
}

/**
 * Creates a 768-dimensional embedding with Gemini Embedding 2. Retries only
 * transient failures; a bad key or bad request fails immediately.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const key = requireGeminiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${encodeURIComponent(
    key,
  )}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          outputDimensionality: EMBEDDING_DIMENSIONS,
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Gemini Embedding API error (${response.status}): ${detail.slice(0, 300)}`,
        );
      }

      const payload: unknown = await response.json();
      const values =
        payload &&
        typeof payload === 'object' &&
        'embedding' in payload &&
        payload.embedding &&
        typeof payload.embedding === 'object' &&
        'values' in payload.embedding &&
        Array.isArray(payload.embedding.values)
          ? payload.embedding.values
          : null;

      if (!values || values.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Gemini Embedding API returned ${
            values?.length ?? 0
          } dimensions; expected ${EMBEDDING_DIMENSIONS}`,
        );
      }
      return values as number[];
    } catch (error) {
      lastError = error;
      if (attempt === 3 || !isRetryable(error)) throw error;
      await sleep(attempt * 1_000);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Gemini embedding request failed');
}

export interface GenerateOptions {
  model?: string;
  generationConfig?: GenerationConfig;
}

/**
 * Single place that talks to the generative model. The model name is pinned to
 * the one verified against this project; a 503/429 is retried, a 404/400 is not.
 */
export async function generateContent(
  prompt: string | Array<string | Part>,
  options: GenerateOptions = {},
): Promise<string> {
  const key = requireGeminiKey();
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel(
    {
      model: options.model ?? VISION_MODEL,
      generationConfig: options.generationConfig,
    },
    { timeout: REQUEST_TIMEOUT_MS },
  );

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await model.generateContent(prompt);
      const text = response.response.text().trim();
      if (!text) throw new Error('Gemini returned an empty response');
      return text;
    } catch (error) {
      lastError = error;
      if (attempt === 3 || !isRetryable(error)) throw error;
      await sleep(attempt * 1_000);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Gemini generation failed');
}

/** Removes markdown fences the model may add despite responseMimeType. */
export function stripJsonFence(text: string): string {
  return text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}
