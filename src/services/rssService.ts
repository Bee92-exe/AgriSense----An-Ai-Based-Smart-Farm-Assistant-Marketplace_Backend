import { decodeEntities, stripCdata } from './text';

/**
 * Minimal RSS 2.0 / Atom reader.
 *
 * shortcut: regex parsing instead of an XML library, upgrade when feeds start
 * carrying nested markup we care about. It is sufficient for the fields a news
 * card needs (title/link/description/date) and deliberately drops everything
 * else rather than guessing. Malformed items are skipped, never thrown: one bad
 * item must not stop an ingest run.
 */

export interface RssItem {
  title: string;
  link: string;
  summary: string;
  publishedAt: Date | null;
}

function firstTag(block: string, ...names: string[]): string {
  for (const name of names) {
    const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
    if (match && match[1]) return stripCdata(match[1]).trim();
  }
  return '';
}

export function parseRss(xml: string): RssItem[] {
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ].map((match) => match[0]);

  const items: RssItem[] = [];
  for (const block of blocks) {
    const title = decodeEntities(firstTag(block, 'title'));
    const link = decodeEntities(
      firstTag(block, 'link') || (/<link[^>]*href="([^"]+)"/i.exec(block)?.[1] ?? ''),
    );
    const summary = decodeEntities(
      firstTag(block, 'description', 'summary', 'content'),
    ).slice(0, 600);
    const rawDate = firstTag(block, 'pubDate', 'published', 'updated');
    const parsedDate = rawDate ? new Date(rawDate) : null;

    if (!title || !link) continue;
    items.push({
      title: title.slice(0, 190),
      link,
      summary: summary || title,
      publishedAt:
        parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
    });
  }
  return items;
}

/**
 * The curated feeds are general Bengali news, so an unfiltered ingest would bury
 * the draft queue under politics and sport. Only items that mention farming are
 * kept — and a human still approves every one of them.
 */
const AGRICULTURE_KEYWORDS = [
  'কৃষি', 'কৃষক', 'ধান', 'আলু', 'টমেটো', 'সবজি', 'ফসল', 'ফলন', 'বীজ', 'সার',
  'কীট', 'পোকা', 'রোগ', 'সেচ', 'বৃষ্টি', 'আবহাওয়া', 'বাগান', 'জমি', 'খামার',
  'agriculture', 'farmer', 'crop', 'harvest', 'paddy', 'fertiliser', 'fertilizer',
];

export function isAgricultureRelated(...texts: Array<string | undefined>): boolean {
  const haystack = texts.filter(Boolean).join(' ').toLowerCase();
  return AGRICULTURE_KEYWORDS.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

/**
 * Bangla-aware tag stripping for feed descriptions. Feeds routinely embed
 * HTML; shipping that into a card would show literal `<p>` to a farmer.
 */
export function plainText(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

