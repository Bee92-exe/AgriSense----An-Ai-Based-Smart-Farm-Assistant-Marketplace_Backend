import { describe, expect, it } from 'vitest';
import { detectRegion, normalizeDialect, tokenizeBangla } from '../src/services/dialectService';

/**
 * The dialect layer must never change a query it does not recognise, and must
 * normalise exactly the variants it declares. These tests pin both directions.
 */
describe('dialect normalisation', () => {
  it('rewrites known dialect and spelling variants', () => {
    const { text, replacements } = normalizeDialect('ধাইন গাছে পুকা লাগছে, ওষুদ দিতে হবে');
    expect(text).toContain('ধান');
    expect(text).toContain('পোকা');
    expect(text).toContain('ওষুধ');
    expect(text).not.toContain('ধাইন');
    expect(replacements.length).toBe(3);
    expect(replacements.map((r) => r.to)).toEqual(['ধান', 'পোকা', 'ওষুধ']);
  });

  it('leaves standard Bangla untouched', () => {
    const sentence = 'আলু গাছে নাবি ধসা রোগ দেখা যাচ্ছে';
    const { text, replacements } = normalizeDialect(sentence);
    expect(text).toBe(sentence);
    expect(replacements).toHaveLength(0);
  });

  it('keeps punctuation and word boundaries intact', () => {
    const { text } = normalizeDialect('কিতা? ধাইন ভালো আছে।');
    expect(text).toBe('কী? ধান ভালো আছে।');
  });

  it('does not rewrite inside an unrelated word', () => {
    const { text, replacements } = normalizeDialect('গাছতলা');
    expect(text).toBe('গাছতলা');
    expect(replacements).toHaveLength(0);
  });

  it('tokenizes Bangla and drops digits and punctuation', () => {
    expect(tokenizeBangla('ধান, আলু ২০২৪!')).toEqual(['ধান', 'আলু']);
  });
});

describe('dialect detection', () => {
  it('identifies a Chittagong transcript from its distinctive words', () => {
    const detection = detectRegion('আঁই আঁর জমিত ধাইন লাগাইছি');
    expect(detection.region).toBe('Chittagong');
    expect(detection.confidence).toBeGreaterThan(0);
    expect(detection.matched_words.length).toBeGreaterThan(0);
  });

  it('returns no region for text it cannot place', () => {
    const detection = detectRegion('আজ আকাশ পরিষ্কার');
    expect(detection.region).toBeNull();
    expect(detection.confidence).toBe(0);
  });
});
