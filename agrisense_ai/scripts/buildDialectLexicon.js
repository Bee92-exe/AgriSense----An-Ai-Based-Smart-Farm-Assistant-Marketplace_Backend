'use strict';

/**
 * Builds the dialect lexicon from BanglaDial.
 *
 * The dataset is `Sentence,Language` with 12 region labels and no standard-Bangla
 * translation, so nothing here invents a translation. It extracts the words that
 * are statistically distinctive of each region (log-odds against the rest of the
 * corpus), which is what the runtime detector matches a transcript against.
 *
 * Output: agrisense_ai/data/dialect_lexicon.json
 * Run:    node agrisense_ai/scripts/buildDialectLexicon.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SOURCE = path.join(DATA_DIR, 'local language dataset', 'BanglaDial.csv');
const TARGET = path.join(DATA_DIR, 'dialect_lexicon.json');

const MIN_COUNT = 4; // a word seen fewer times is noise, not a dialect marker
const PER_REGION = 80; // enough to detect, small enough to ship

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length));
}

/** Bangla-aware tokenizer: keeps Bengali letters, drops punctuation/digits. */
function tokenize(sentence) {
  return sentence
    .toLowerCase()
    .split(/[\s,।!?;:"'()\[\]{}\/\-–—…]+/u)
    .map((token) => token.replace(/[^\u0980-\u09FF\u200c\u200d]/gu, ''))
    .filter((token) => token.length > 1);
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error('Missing dataset:', SOURCE);
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(SOURCE, 'utf8')).slice(1);
  const perRegion = new Map(); // label -> Map(word -> count)
  const regionTotals = new Map();
  let tokens = 0;
  const seen = new Set();
  let duplicates = 0;

  for (const row of rows) {
    const sentence = (row[0] || '').trim();
    const label = (row[1] || '').trim();
    if (!sentence || !label) continue;

    // Identical sentences add nothing but weight; count them once.
    const dedupeKey = `${label}\u0000${sentence}`;
    if (seen.has(dedupeKey)) {
      duplicates += 1;
      continue;
    }
    seen.add(dedupeKey);

    if (!perRegion.has(label)) {
      perRegion.set(label, new Map());
      regionTotals.set(label, 0);
    }
    const counts = perRegion.get(label);
    for (const token of tokenize(sentence)) {
      counts.set(token, (counts.get(token) || 0) + 1);
      regionTotals.set(label, regionTotals.get(label) + 1);
      tokens += 1;
    }
  }

  const globalTotals = new Map();
  let corpusTokens = 0;
  for (const [label, counts] of perRegion) {
    for (const [word, count] of counts) {
      globalTotals.set(word, (globalTotals.get(word) || 0) + count);
      corpusTokens += count;
    }
    if (!regionTotals.get(label)) regionTotals.set(label, 0);
  }

  const regions = {};
  for (const [label, counts] of perRegion) {
    const regionTotal = regionTotals.get(label) || 1;
    const scored = [];
    for (const [word, count] of counts) {
      if (count < MIN_COUNT) continue;
      const outside = (globalTotals.get(word) || 0) - count;
      const outsideTotal = Math.max(1, corpusTokens - regionTotal);
      // Log-odds: how much more this region uses the word than everywhere else.
      const score = Math.log((count + 1) / regionTotal) - Math.log((outside + 1) / outsideTotal);
      if (score <= 0) continue;
      scored.push({ word, count, score: +score.toFixed(4) });
    }
    scored.sort((a, b) => b.score - a.score);
    regions[label] = scored.slice(0, PER_REGION);
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source: 'BanglaDial.csv',
    license_note:
      'Derived word statistics only. BanglaDial: "A Merged and Imbalanced text Dataset for Bengali Regional dialect analysis". Verify redistribution terms before shipping.',
    rows: rows.length,
    duplicate_rows_skipped: duplicates,
    tokens,
    regions_declared: Object.keys(regions).length,
    min_count: MIN_COUNT,
    per_region: PER_REGION,
    regions,
  };

  fs.writeFileSync(TARGET, `${JSON.stringify(payload, null, 1)}\n`, 'utf8');

  const summary = Object.entries(regions)
    .map(([label, words]) => ({ label, words: words.length, sample: words.slice(0, 6).map((w) => w.word) }))
    .sort((a, b) => b.words - a.words);

  console.log(
    JSON.stringify(
      { rows: rows.length, duplicates_skipped: duplicates, tokens, regions: summary.length, detail: summary },
      null,
      1,
    ),
  );
}

main();
