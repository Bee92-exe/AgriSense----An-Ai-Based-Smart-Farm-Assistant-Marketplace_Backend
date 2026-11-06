import { Request, Response } from 'express';
import prisma from '../config/db';
import { env } from '../config/env';
import { AppError } from '../lib/errors';
import type { AuthRequest } from '../middleware/authMiddleware';
import { parseRss, plainText } from '../services/rssService';

/** Wire shape the Flutter `NewsItem.fromJson` already expects. */
function toWire(item: {
  id: string;
  titleBn: string;
  titleEn: string | null;
  summaryBn: string;
  summaryEn: string | null;
  symptomsBn: string | null;
  advisedActionBn: string | null;
  category: string;
  crop: string | null;
  severity: string;
  affectedDistricts: string[];
  sourceName: string;
  sourceUrl: string | null;
  verifiedBy: string | null;
  publishedAt: Date | null;
  imageUrls: string[];
  isUrgent: boolean;
}, isRead: boolean) {
  return {
    id: item.id,
    title_bn: item.titleBn,
    title_en: item.titleEn,
    summary_bn: item.summaryBn,
    summary_en: item.summaryEn,
    symptoms_bn: item.symptomsBn,
    advised_action_bn: item.advisedActionBn,
    category: item.category.toLowerCase(),
    crop: item.crop,
    severity: item.severity.toLowerCase(),
    affected_districts: item.affectedDistricts,
    source: { name: item.sourceName, url: item.sourceUrl },
    verified_by: item.verifiedBy,
    published_at: (item.publishedAt ?? new Date()).toISOString(),
    images: item.imageUrls,
    is_urgent: item.isUrgent,
    read: isRead,
  };
}

/**
 * Published items only, newest first. Drafts and archived rows are filtered in
 * the query itself rather than in the client, so an unapproved item cannot leak
 * to a farmer through any code path.
 */
export const listNews = async (req: AuthRequest, res: Response): Promise<void> => {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20) || 20));
  const crop = typeof req.query.crop === 'string' ? req.query.crop : undefined;
  const category = typeof req.query.category === 'string' ? req.query.category.toUpperCase() : undefined;

  const where = {
    status: 'PUBLISHED' as const,
    ...(crop ? { crop } : {}),
    ...(category ? { category: category as never } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.newsItem.findMany({
      where,
      orderBy: [{ isUrgent: 'desc' }, { publishedAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.newsItem.count({ where }),
  ]);

  const readIds = new Set<string>();
  if (req.user?.id && items.length > 0) {
    const reads = await prisma.newsRead.findMany({
      where: { userId: req.user.id, newsId: { in: items.map((i) => i.id) } },
      select: { newsId: true },
    });
    for (const read of reads) readIds.add(read.newsId);
  }

  res.status(200).json({
    success: true,
    page,
    total,
    items: items.map((item) => toWire(item, readIds.has(item.id))),
  });
};

export const getNews = async (req: AuthRequest, res: Response): Promise<void> => {
  const item = await prisma.newsItem.findUnique({ where: { id: String(req.params.id) } });
  if (!item || item.status !== 'PUBLISHED') {
    throw new AppError(404, 'not_found', 'News item not found', undefined, 'খবরটি পাওয়া যায়নি।');
  }

  const read = req.user?.id
    ? await prisma.newsRead.findUnique({
        where: { newsId_userId: { newsId: item.id, userId: req.user.id } },
      })
    : null;

  res.status(200).json({ success: true, item: toWire(item, Boolean(read)) });
};

/** FR-46: idempotent read receipt. */
export const markNewsRead = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');
  const newsId = String(req.params.id);

  const item = await prisma.newsItem.findUnique({ where: { id: newsId }, select: { id: true } });
  if (!item) {
    throw new AppError(404, 'not_found', 'News item not found', undefined, 'খবরটি পাওয়া যায়নি।');
  }

  await prisma.newsRead.upsert({
    where: { newsId_userId: { newsId, userId } },
    create: { newsId, userId },
    update: {},
  });

  res.status(204).send();
};

/**
 * Products shown under a disease item (FR-49).
 *
 * These are the in-stock catalogue entries, not a claim that a product treats
 * this specific disease — the corpus does not model that link, and inventing it
 * would be a safety problem.
 */
export const getNewsProducts = async (req: Request, res: Response): Promise<void> => {
  const item = await prisma.newsItem.findUnique({
    where: { id: String(req.params.id) },
    select: { crop: true, category: true },
  });
  if (!item) {
    throw new AppError(404, 'not_found', 'News item not found', undefined, 'খবরটি পাওয়া যায়নি।');
  }

  const products = await prisma.product.findMany({
    where: {
      stockLevel: { gt: 0 },
      ...(item.category === 'PEST' || item.category === 'DISEASE'
        ? { category: { in: ['Pesticide', 'Fungicide'] } }
        : {}),
    },
    include: { vendor: { include: { user: { select: { name: true } } } } },
    orderBy: { rating: 'desc' },
    take: 6,
  });

  res.status(200).json({
    success: true,
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      category: product.category,
      price: Math.round(product.price),
      stock: product.stockLevel,
      in_stock: product.stockLevel > 0,
      description: product.description,
      image_url: product.imageUrl,
      vendor: {
        id: product.vendorId,
        shop_name: product.vendor?.shopName ?? '',
        verified: (product.vendor?.verificationStatus ?? '') === 'ACTIVE',
        rating: product.rating,
      },
    })),
  });
};

/** Expert/admin authoring. Always creates a DRAFT unless publish is explicit. */
export const createNews = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const body = req.body as Record<string, unknown>;
  const titleBn = typeof body.title_bn === 'string' ? body.title_bn.trim() : '';
  const summaryBn = typeof body.summary_bn === 'string' ? body.summary_bn.trim() : '';
  if (titleBn.length < 3 || summaryBn.length < 10) {
    throw new AppError(
      400,
      'validation_error',
      'title_bn and summary_bn are required',
      undefined,
      'শিরোনাম ও সারসংক্ষেপ লিখুন।',
    );
  }

  const publish = body.publish === true;
  const category = typeof body.category === 'string' ? body.category.toUpperCase() : 'DISEASE';
  const severity = typeof body.severity === 'string' ? body.severity.toUpperCase() : 'LOW';

  const item = await prisma.newsItem.create({
    data: {
      titleBn,
      titleEn: typeof body.title_en === 'string' ? body.title_en : null,
      summaryBn,
      summaryEn: typeof body.summary_en === 'string' ? body.summary_en : null,
      symptomsBn: typeof body.symptoms_bn === 'string' ? body.symptoms_bn : null,
      advisedActionBn: typeof body.advised_action_bn === 'string' ? body.advised_action_bn : null,
      category: category as never,
      severity: severity as never,
      crop: typeof body.crop === 'string' && body.crop ? body.crop : null,
      sourceName: typeof body.source === 'string' && body.source ? body.source : 'AgriSense',
      sourceUrl: typeof body.source_url === 'string' ? body.source_url : null,
      verifiedBy: typeof body.verified_by === 'string' ? body.verified_by : null,
      isUrgent: body.is_urgent === true,
      status: publish ? 'PUBLISHED' : 'DRAFT',
      publishedAt: publish ? new Date() : null,
      authorId: userId,
    },
  });

  res.status(201).json({ success: true, item: toWire(item, false) });
};

/**
 * Pulls the configured feeds and stores new items as DRAFTS.
 *
 * Nothing here publishes: an RSS feed is not a verified source, and a farmer
 * acting on an unmoderated headline is exactly the failure this table exists to
 * prevent.
 */
export const ingestNews = async (_req: AuthRequest, res: Response): Promise<void> => {
  const feeds = env.RSS_FEEDS.split(',')
    .map((feed) => feed.trim())
    .filter(Boolean);

  if (feeds.length === 0) {
    throw new AppError(
      503,
      'rss_not_configured',
      'RSS_FEEDS is empty',
      undefined,
      'কোনো সংবাদ উৎস এখনো যুক্ত হয়নি।',
    );
  }

  let created = 0;
  let skipped = 0;

  for (const feed of feeds) {
    let xml = '';
    try {
      const response = await fetch(feed, { headers: { Accept: 'application/rss+xml, application/xml' } });
      if (!response.ok) continue;
      xml = await response.text();
    } catch {
      continue;
    }

    const parsed = parseRss(xml);
    const host = (() => {
      try {
        return new URL(feed).host;
      } catch {
        return feed;
      }
    })();

    for (const item of parsed) {
      const externalId = `rss:${item.link}`.slice(0, 290);
      const existing = await prisma.newsItem.findUnique({ where: { externalId }, select: { id: true } });
      if (existing) {
        skipped += 1;
        continue;
      }
      await prisma.newsItem.create({
        data: {
          titleBn: plainText(item.title).slice(0, 190),
          summaryBn: plainText(item.summary).slice(0, 2000),
          sourceName: host,
          sourceUrl: item.link,
          externalId,
          status: 'DRAFT',
          publishedAt: item.publishedAt,
        },
      });
      created += 1;
    }
  }

  res.status(200).json({ success: true, created, skipped, feeds: feeds.length });
};
