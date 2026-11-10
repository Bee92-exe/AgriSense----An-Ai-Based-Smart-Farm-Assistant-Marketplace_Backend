import fs from 'fs';
import path from 'path';

/**
 * Dialect detection and normalisation.
 *
 * BanglaDial is a classification corpus: 63k sentences labelled with one of 12
 * regions, with no standard-Bangla translation. So this module does two honest
 * things and nothing more:
 *
 *  1. `detectRegion` matches the transcript against the region-distinctive words
 *     mined by `agrisense_ai/scripts/buildDialectLexicon.js`.
 *  2. `normalizeDialect` rewrites a small, curated set of dialect/ASR variants
 *     into the standard spelling the corpus RAG was indexed with.
 *
 * Normalisation never invents an answer — it only makes the farmer's own words
 * findable. The curated map is a starter set and every entry is marked for
 * agronomist review.
 */

interface LexiconEntry {
  word: string;
  count: number;
  score: number;
}

interface DialectLexicon {
  generated_at: string;
  rows: number;
  regions: Record<string, LexiconEntry[]>;
}

export interface DialectDetection {
  region: string | null;
  confidence: number;
  matched_words: string[];
}

export interface DialectNormalization {
  text: string;
  replacements: Array<{ from: string; to: string }>;
}

const LEXICON_PATH = path.join(__dirname, '..', '..', 'agrisense_ai', 'data', 'dialect_lexicon.json');

/** Distinctive words a transcript must share with a region before it is named. */
const MIN_MATCHES = 2;

/**
 * Starter map: dialect and common speech-to-text variants → standard Bangla.
 *
 * `shortcut: hand-authored starter map, upgrade when an agronomist reviews it`.
 * Only confident, single-token substitutions are listed; a wrong entry would
 * silently change what the farmer asked, which is worse than missing a match.
 */
export const CURATED_NORMALIZATIONS: ReadonlyArray<{ from: string; to: string; note: string }> = [
  // Pronouns and everyday dialect forms
  { from: 'আঁই', to: 'আমি', note: 'চট্টগ্রাম' },
  { from: 'আঁর', to: 'আমার', note: 'চট্টগ্রাম' },
  { from: 'মোরা', to: 'আমরা', note: 'বরিশাল' },
  { from: 'তুই', to: 'তুমি', note: 'সর্বত্র' },
  { from: 'কিতা', to: 'কী', note: 'সিলেট' },
  { from: 'কিমতা', to: 'কেমন', note: 'সিলেট' },
  { from: 'কেমনে', to: 'কেমন', note: 'সর্বত্র' },
  { from: 'কতো', to: 'কত', note: 'সর্বত্র' },
  { from: 'হইবো', to: 'হবে', note: 'সর্বত্র' },
  { from: 'অইবো', to: 'হবে', note: 'সর্বত্র' },
  { from: 'লাগবো', to: 'লাগবে', note: 'সর্বত্র' },
  { from: 'যাইতাসি', to: 'যাচ্ছি', note: 'ময়মনসিংহ' },
  { from: 'লাগতাসে', to: 'লাগছে', note: 'ময়মনসিংহ' },
  { from: 'ধইরা', to: 'ধরে', note: 'সর্বত্র' },
  // Spelling / speech-to-text variants of farming words
  { from: 'ধাইন', to: 'ধান', note: 'উচ্চারণভেদ' },
  { from: 'ধাইনে', to: 'ধানে', note: 'উচ্চারণভেদ' },
  { from: 'ধাইনের', to: 'ধানের', note: 'উচ্চারণভেদ' },
  { from: 'পুকা', to: 'পোকা', note: 'উচ্চারণভেদ' },
  { from: 'ফানি', to: 'পানি', note: 'উচ্চারণভেদ' },
  { from: 'গাস', to: 'গাছ', note: 'উচ্চারণভেদ' },
  { from: 'জমিন', to: 'জমি', note: 'উচ্চারণভেদ' },
  { from: 'ঔষধ', to: 'ওষুধ', note: 'বানান' },
  { from: 'ওষুদ', to: 'ওষুধ', note: 'উচ্চারণভেদ' },
  { from: 'ফসিল', to: 'ফসল', note: 'উচ্চারণভেদ' },
  { from: 'বিজ', to: 'বীজ', note: 'উচ্চারণভেদ' },
  { from: 'খেইত', to: 'খেত', note: 'উচ্চারণভেদ' },
  { from: 'সরিষা', to: 'সরিষা', note: 'বানান' },
];

let cachedLexicon: DialectLexicon | null | undefined;

function loadLexicon(): DialectLexicon | null {
  if (cachedLexicon !== undefined) return cachedLexicon;
  try {
    cachedLexicon = JSON.parse(fs.readFileSync(LEXICON_PATH, 'utf8')) as DialectLexicon;
  } catch (error) {
    // The lexicon is an enhancement: without it the assistant still works.
    console.warn(
      '[Dialect] lexicon unavailable:',
      error instanceof Error ? error.message : error,
    );
    cachedLexicon = null;
  }
  return cachedLexicon;
}

/** Shared Bangla-aware tokenizer; punctuation and digits are not words. */
export function tokenizeBangla(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .split(/[\s,।!?;:"'()[\]{}\/\-–—…]+/u)
    .map((token) =>
      token
        .replace(/[^\u0980-\u09FF\u200c\u200d]/gu, '')
        // Bengali, Devanagari and Arabic-Indic digits sit inside the Bengali block.
        .replace(/[\u09E6-\u09EF\u0966-\u096F\u0660-\u0669]/gu, ''),
    )
    .filter((token) => token.length > 1);
}

const normalisationMap = new Map(
  CURATED_NORMALIZATIONS.filter((entry) => entry.from !== entry.to).map((entry) => [entry.from, entry.to]),
);

/** Rewrites known variants token by token; everything else is left untouched. */
export function normalizeDialect(text: string): DialectNormalization {
  const replacements: Array<{ from: string; to: string }> = [];
  const rewritten = text
    .split(/(\s+)/)
    .map((chunk) => {
      if (!chunk.trim()) return chunk;
      const leading = chunk.match(/^[^\u0980-\u09FF]*/u)?.[0] ?? '';
      const trailing = chunk.match(/[^\u0980-\u09FF]*$/u)?.[0] ?? '';
      const core = chunk.slice(leading.length, chunk.length - trailing.length);
      const target = normalisationMap.get(core);
      if (!target) return chunk;
      replacements.push({ from: core, to: target });
      return `${leading}${target}${trailing}`;
    })
    .join('');

  return { text: rewritten, replacements };
}

/**
 * Scores each region by how many of its distinctive words appear. Confidence is
 * the winner's share of the two strongest scores, so one shared word cannot read
 * as certainty.
 */
export function detectRegion(text: string): DialectDetection {
  const lexicon = loadLexicon();
  const tokens = new Set(tokenizeBangla(text));
  if (!lexicon || tokens.size === 0) {
    return { region: null, confidence: 0, matched_words: [] };
  }

  const scores: Array<{ region: string; score: number; matched: string[] }> = [];
  for (const [region, entries] of Object.entries(lexicon.regions)) {
    // Already-standard Bangla needs no dialect handling, so it is not a hit.
    if (region === 'Standard_Bangla') continue;
    let score = 0;
    const matched: string[] = [];
    for (const entry of entries) {
      if (!tokens.has(entry.word)) continue;
      score += entry.score;
      matched.push(entry.word);
    }
    if (score > 0) scores.push({ region, score, matched });
  }

  if (scores.length === 0) return { region: null, confidence: 0, matched_words: [] };

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  // One shared word is not evidence of a region; it is how ordinary Bangla
  // would otherwise be mislabelled.
  if (best.matched.length < MIN_MATCHES) {
    return { region: null, confidence: 0, matched_words: [] };
  }
  const runnerUp = scores[1]?.score ?? 0;
  const confidence = best.score + runnerUp === 0 ? 0 : best.score / (best.score + runnerUp);

  return {
    region: best.region,
    confidence: +confidence.toFixed(2),
    matched_words: best.matched.slice(0, 6),
  };
}
