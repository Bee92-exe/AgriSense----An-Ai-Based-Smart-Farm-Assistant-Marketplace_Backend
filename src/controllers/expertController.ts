import { Response } from 'express';
import prisma from '../config/db';
import { AppError } from '../lib/errors';
import type { AuthRequest } from '../middleware/authMiddleware';
import { getEmbedding } from '../services/rag/gemini';
import { resolveCropScanImage } from '../services/storageService';

/**
 * The expert workspace.
 *
 * Two audiences share this file:
 *  - `/api/expert/*` — the signed-in expert's own console (role-gated).
 *  - `/api/articles`, `/api/questions` — the farmer-facing side of the same
 *    rows, so a farmer reads and reacts to the exact record the expert wrote.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface TreatmentPayload {
  crop_en?: string;
  review_reason?: string;
  ai_disease_name?: string;
  is_grounded_rag?: boolean;
}

function parseTreatment(raw: string): TreatmentPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as TreatmentPayload) : {};
  } catch {
    return {};
  }
}

function confidenceRatio(raw: number): number {
  const value = Number.isFinite(raw) ? raw : 0;
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

function requireUser(req: AuthRequest): string {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');
  return userId;
}

async function expertFor(userId: string) {
  const expert = await prisma.expert.findUnique({ where: { userId } });
  if (!expert) {
    throw new AppError(
      403,
      'forbidden',
      'Expert profile not found',
      undefined,
      'বিশেষজ্ঞের প্রোফাইল পাওয়া যায়নি।',
    );
  }
  return expert;
}

function notFound(what: string, bn: string) {
  return new AppError(404, 'not_found', `${what} not found`, undefined, bn);
}

/** Mirrors the enums in `schema.prisma`; anything unknown falls back safely. */
function pickCategory(value: string): 'DISEASE' | 'PEST' | 'VIRUS' | 'NUTRIENT_DEFICIENCY' | 'WEATHER' | 'MARKET' | 'ADVISORY' {
  const raw = value.trim().toUpperCase();
  const allowed = ['DISEASE', 'PEST', 'VIRUS', 'NUTRIENT_DEFICIENCY', 'WEATHER', 'MARKET', 'ADVISORY'];
  return (allowed.includes(raw) ? raw : 'DISEASE') as ReturnType<typeof pickCategory>;
}

function pickSeverity(value: string): 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' {
  const raw = value.trim().toUpperCase();
  const allowed = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
  return (allowed.includes(raw) ? raw : 'MEDIUM') as ReturnType<typeof pickSeverity>;
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export const getPendingDiagnoses = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  await expertFor(userId);

  const diagnoses = await prisma.diagnosis.findMany({
    where: { status: 'PENDING_REVIEW' },
    include: { user: { select: { name: true, location: true } } },
    orderBy: { timestamp: 'asc' },
    take: 50,
  });

  const mapped = await Promise.all(
    diagnoses.map(async (diagnosis) => {
      const parsed = parseTreatment(diagnosis.treatmentSteps);
      return {
        id: diagnosis.id,
        crop: parsed.crop_en?.toLowerCase() ?? null,
        disease: diagnosis.aiDetectedDisease,
        confidence: confidenceRatio(diagnosis.confidenceScore),
        imageUrl: await resolveCropScanImage(diagnosis.imageUrl),
        date: diagnosis.timestamp,
        farmerName: diagnosis.user?.name || 'Unknown',
        farmerLocation: diagnosis.user?.location || '',
        hasImage: Boolean(diagnosis.imageUrl),
        reviewReason: parsed.review_reason || 'low_confidence',
        ai_top3: parsed.ai_disease_name
          ? [
              {
                disease_id: diagnosis.id,
                name_bn: parsed.ai_disease_name,
                name_en: '',
                confidence: confidenceRatio(diagnosis.confidenceScore),
              },
            ]
          : [],
      };
    }),
  );

  res.status(200).json({ success: true, diagnoses: mapped });
};

export const reviewDiagnosis = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);

  const diagnosisId = String(req.params.id);
  const { review, note, diseaseName } = req.body as {
    review?: string;
    note?: string;
    diseaseName?: string;
  };
  const reviewText = (review ?? note ?? '').trim();
  if (reviewText.length < 3) {
    throw new AppError(
      400,
      'validation_error',
      'A review note is required',
      [{ field: 'review', message: 'A review note is required', message_bn: 'পর্যালোচনার মন্তব্য লিখুন।' }],
      'পর্যালোচনার মন্তব্য লিখুন।',
    );
  }

  const diagnosis = await prisma.diagnosis.findUnique({ where: { id: diagnosisId } });
  if (!diagnosis) throw notFound('Diagnosis', 'রোগ নির্ণয়ের তথ্য পাওয়া যায়নি।');
  if (diagnosis.status !== 'PENDING_REVIEW') {
    throw new AppError(
      409,
      'conflict',
      'This case is not pending review',
      undefined,
      'এই ছবিটি পর্যালোচনার অপেক্ষায় নেই।',
    );
  }

  const confirmedName = typeof diseaseName === 'string' ? diseaseName.trim() : '';
  const treatment = parseTreatment(diagnosis.treatmentSteps);
  const treatmentJson = confirmedName
    ? JSON.stringify({ ...treatment, ai_disease_name: confirmedName, is_grounded_rag: true })
    : diagnosis.treatmentSteps;

  const updated = await prisma.diagnosis.update({
    where: { id: diagnosisId },
    data: {
      expertReview: reviewText,
      expertId: expert.id,
      status: 'COMPLETED',
      ...(confirmedName
        ? {
            aiDetectedDisease: confirmedName,
            confidenceScore: Math.max(diagnosis.confidenceScore, 0.9),
            treatmentSteps: treatmentJson,
          }
        : {}),
    },
  });

  res.status(200).json({
    success: true,
    diagnosis: {
      id: updated.id,
      status: 'completed',
      reviewed_by_expert: true,
      expert_note: updated.expertReview,
      disease_name: diseaseName || updated.aiDetectedDisease,
    },
  });
};

export const needsRetake = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);

  const diagnosisId = String(req.params.id);
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';

  const diagnosis = await prisma.diagnosis.findUnique({ where: { id: diagnosisId } });
  if (!diagnosis) throw notFound('Diagnosis', 'রোগ নির্ণয়ের তথ্য পাওয়া যায়নি।');
  if (diagnosis.status !== 'PENDING_REVIEW') {
    throw new AppError(
      409,
      'conflict',
      'This case is not pending review',
      undefined,
      'এই ছবিটি পর্যালোচনার অপেক্ষায় নেই।',
    );
  }

  const updated = await prisma.diagnosis.update({
    where: { id: diagnosisId },
    data: {
      expertReview: note || 'অনুগ্রহ করে আরও পরিষ্কার আলোতে পাতার ছবি তুলুন।',
      expertId: expert.id,
      status: 'NEEDS_RETAKE',
    },
  });

  res.status(200).json({
    success: true,
    diagnosis: {
      id: updated.id,
      status: 'needs_retake',
      expert_note: updated.expertReview,
    },
  });
};

// ---------------------------------------------------------------------------
// Shared serializers
// ---------------------------------------------------------------------------

const articleInclude = {
  expert: { include: { user: { select: { name: true } } } },
  comments: {
    include: { user: { select: { name: true, role: true } } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  },
  _count: { select: { likes: true, saves: true, ratings: true } },
} as const;

type ArticleRecord = Awaited<ReturnType<typeof loadArticle>>;

async function loadArticle(id: string) {
  return prisma.expertArticle.findUnique({ where: { id }, include: articleInclude });
}

async function toWireArticle(
  article: NonNullable<ArticleRecord>,
  viewerId: string | null,
) {
  const [ratingAggregate, liked, saved] = await Promise.all([
    prisma.articleRating.aggregate({ where: { articleId: article.id }, _avg: { rating: true } }),
    viewerId
      ? prisma.articleLike.findUnique({
          where: { articleId_userId: { articleId: article.id, userId: viewerId } },
          select: { userId: true },
        })
      : Promise.resolve(null),
    viewerId
      ? prisma.articleSave.findUnique({
          where: { articleId_userId: { articleId: article.id, userId: viewerId } },
          select: { userId: true },
        })
      : Promise.resolve(null),
  ]);

  return {
    id: article.id,
    title: article.title,
    summary: article.summary,
    body: article.body,
    author_name: article.expert?.user?.name ?? 'AgriSense Expert',
    author_title: article.expert?.specialization ?? '',
    crop: article.crop,
    published_at: article.publishedAt.toISOString(),
    likes: article._count.likes,
    views: article.views,
    rating: ratingAggregate._avg.rating ?? 0,
    rating_count: article._count.ratings,
    cover_tone: article.coverTone,
    liked: Boolean(liked),
    saved: Boolean(saved),
    mine: viewerId != null && article.expert?.userId === viewerId,
    comments: article.comments.map((comment) => ({
      id: comment.id,
      author_name: comment.user?.name ?? '',
      body: comment.body,
      at: comment.createdAt.toISOString(),
      is_expert: comment.user?.role === 'EXPERT',
      likes: comment.likes,
    })),
  };
}

const questionInclude = {
  farmer: { select: { name: true, location: true } },
} as const;

type QuestionRecord = Awaited<ReturnType<typeof prisma.expertQuestion.findFirst>>;

function toWireQuestion(question: NonNullable<QuestionRecord> & {
  farmer?: { name: string; location: string | null } | null;
}) {
  return {
    id: question.id,
    farmer_name: question.farmer?.name ?? '',
    farmer_district: question.farmer?.location ?? '',
    crop: question.crop,
    question: question.question,
    mode: question.mode,
    urgent: question.urgent,
    answered: question.status === 'ANSWERED',
    reply: question.reply,
    created_at: question.createdAt.toISOString(),
    answered_at: question.answeredAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Expert desk
// ---------------------------------------------------------------------------

export const getExpertDesk = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);

  const [articles, questions, plans, bookings, peerRows, peerTargets, followers, answered] =
    await Promise.all([
      prisma.expertArticle.findMany({
        where: { expertId: expert.id },
        include: articleInclude,
        orderBy: { publishedAt: 'desc' },
        take: 50,
      }),
      prisma.expertQuestion.findMany({
        where: { OR: [{ expertId: expert.id }, { expertId: null }] },
        include: questionInclude,
        orderBy: [{ urgent: 'desc' }, { createdAt: 'asc' }],
        take: 100,
      }),
      prisma.consultationPlan.findMany({ where: { expertId: expert.id }, orderBy: { createdAt: 'desc' } }),
      prisma.consultationBooking.findMany({
        where: { plan: { expertId: expert.id } },
        include: { farmer: { select: { name: true } }, plan: { select: { price: true } } },
        orderBy: { at: 'asc' },
        take: 100,
      }),
      prisma.expertPeer.findMany({ where: { expertId: expert.id }, select: { peerId: true } }),
      prisma.expert.findMany({
        where: { id: { not: expert.id } },
        include: { user: { select: { name: true, location: true } }, _count: { select: { peerOf: true } } },
        take: 30,
      }),
      prisma.expertPeer.count({ where: { peerId: expert.id } }),
      prisma.expertQuestion.findMany({
        where: { expertId: expert.id, status: 'ANSWERED', answeredAt: { not: null } },
        select: { createdAt: true, answeredAt: true },
      }),
    ]);

  const connected = new Set(peerRows.map((row) => row.peerId));
  const ratingAggregate = await prisma.articleRating.aggregate({
    where: { article: { expertId: expert.id } },
    _avg: { rating: true },
  });

  const responseMinutes = answered.length
    ? Math.round(
        answered.reduce(
          (sum, row) => sum + ((row.answeredAt as Date).getTime() - row.createdAt.getTime()) / 60_000,
          0,
        ) / answered.length,
      )
    : 0;

  const subscribers = new Set(bookings.map((booking) => booking.farmerId)).size;
  const earnings = bookings
    .filter((booking) => booking.status !== 'CANCELLED')
    .reduce((sum, booking) => sum + booking.plan.price, 0);

  res.status(200).json({
    success: true,
    desk: {
      articles: await Promise.all(articles.map((article) => toWireArticle(article, userId))),
      questions: questions.map(toWireQuestion),
      plans: plans.map((plan) => ({
        id: plan.id,
        title: plan.title,
        period: plan.period,
        price: Math.round(plan.price),
        perks: plan.perks,
        active: plan.active,
        subscribers: bookings.filter((booking) => booking.planId === plan.id).length,
      })),
      bookings: bookings.map((booking) => ({
        id: booking.id,
        farmer_name: booking.farmer?.name ?? '',
        topic: booking.topic,
        mode: booking.mode,
        at: booking.at.toISOString(),
        minutes: booking.minutes,
        status: booking.status.toLowerCase(),
      })),
      peers: peerTargets.map((peer) => ({
        id: peer.id,
        name: peer.user?.name ?? '',
        specialization: peer.specialization,
        district: peer.user?.location ?? '',
        rating: 0,
        followers: peer._count.peerOf,
        connected: connected.has(peer.id),
      })),
      rating: ratingAggregate._avg.rating ?? 0,
      followers,
      subscribers,
      earnings: Math.round(earnings),
      response_minutes: responseMinutes,
    },
  });
};

export const getExpertStats = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);

  const [totalReviewed, pendingReview, articlesWritten, answered] = await Promise.all([
    prisma.diagnosis.count({ where: { expertId: expert.id } }),
    prisma.diagnosis.count({ where: { status: 'PENDING_REVIEW' } }),
    prisma.expertArticle.count({ where: { expertId: expert.id } }),
    prisma.expertQuestion.count({ where: { expertId: expert.id, status: 'ANSWERED' } }),
  ]);

  res.status(200).json({
    success: true,
    stats: {
      totalReviewed,
      pendingReview,
      articlesWritten,
      farmersHelped: totalReviewed + answered,
    },
  });
};

// ---------------------------------------------------------------------------
// Krishi Barta review queue
// ---------------------------------------------------------------------------

const newsInclude = { author: { select: { name: true } } } as const;

type NewsRecord = NonNullable<Awaited<ReturnType<typeof prisma.newsItem.findFirst>>> & {
  author?: { name: string } | null;
};

function toWireDraft(item: NewsRecord) {
  return {
    id: item.id,
    status: item.status.toLowerCase(),
    title_bn: item.titleBn,
    summary_bn: item.summaryBn,
    symptoms_bn: item.symptomsBn,
    advised_action_bn: item.advisedActionBn,
    category: item.category.toLowerCase(),
    crop: item.crop ?? '',
    severity: item.severity.toLowerCase(),
    affected_districts: item.affectedDistricts,
    source_name: item.sourceName,
    source_url: item.sourceUrl ?? '',
    is_urgent: item.isUrgent,
    published_at: item.publishedAt?.toISOString() ?? null,
    updated_at: item.updatedAt.toISOString(),
    author_name: item.author?.name ?? '',
  };
}

/** Drafts awaiting review, newest first. Published items are not a queue. */
export const getExpertNewsQueue = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  await expertFor(userId);

  const items = await prisma.newsItem.findMany({
    where: { status: { in: ['DRAFT', 'ARCHIVED'] } },
    include: newsInclude,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  res.status(200).json({ success: true, drafts: items.map(toWireDraft) });
};

export const saveNewsDraft = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === 'string' ? body.id.trim() : '';

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

  const data = {
    titleBn,
    summaryBn,
    symptomsBn: typeof body.symptoms_bn === 'string' ? body.symptoms_bn : null,
    advisedActionBn: typeof body.advised_action_bn === 'string' ? body.advised_action_bn : null,
    crop: typeof body.crop === 'string' && body.crop ? body.crop : null,
    isUrgent: body.is_urgent === true,
    ...(typeof body.category === 'string' ? { category: pickCategory(body.category) } : {}),
    ...(typeof body.severity === 'string' ? { severity: pickSeverity(body.severity) } : {}),
    ...(typeof body.source_name === 'string' && body.source_name.trim()
      ? { sourceName: body.source_name.trim() }
      : {}),
    ...(typeof body.source_url === 'string' && body.source_url.trim()
      ? { sourceUrl: body.source_url.trim() }
      : {}),
    ...(Array.isArray(body.affected_districts)
      ? {
          affectedDistricts: body.affected_districts.filter(
            (district): district is string => typeof district === 'string',
          ),
        }
      : {}),
  };

  if (id) {
    if (!UUID_PATTERN.test(id)) throw notFound('Draft', 'খসড়াটি পাওয়া যায়নি।');
    const existing = await prisma.newsItem.findUnique({ where: { id } });
    if (!existing) throw notFound('Draft', 'খসড়াটি পাওয়া যায়নি।');
    if (existing.status === 'PUBLISHED') {
      throw new AppError(
        409,
        'conflict',
        'A published item cannot be edited',
        undefined,
        'প্রকাশিত সংবাদ সম্পাদনা করা যাবে না।',
      );
    }
    const updated = await prisma.newsItem.update({
      where: { id },
      data,
      include: newsInclude,
    });
    res.status(200).json({ success: true, draft: toWireDraft(updated) });
    return;
  }

  const created = await prisma.newsItem.create({
    data: {
      ...data,
      category: 'DISEASE',
      severity: 'MEDIUM',
      sourceName: 'AgriSense Expert',
      status: 'DRAFT',
      authorId: userId,
    },
    include: newsInclude,
  });

  res.status(201).json({ success: true, draft: toWireDraft(created) });
};

/**
 * Publishing is the expert's authority (FR-44). Nothing else in the system can
 * flip a DRAFT to PUBLISHED, which is what keeps an unverified feed off a
 * farmer's screen.
 */
export const approveNews = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) throw notFound('Draft', 'খসড়াটি পাওয়া যায়নি।');

  const existing = await prisma.newsItem.findUnique({ where: { id } });
  if (!existing) throw notFound('Draft', 'খসড়াটি পাওয়া যায়নি।');
  if (existing.status === 'PUBLISHED') {
    throw new AppError(409, 'conflict', 'Already published', undefined, 'এটি ইতিমধ্যে প্রকাশিত।');
  }

  const urgent = (req.body as Record<string, unknown>)?.urgent === true;
  const expertUser = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });

  const updated = await prisma.newsItem.update({
    where: { id },
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      isUrgent: urgent,
      verifiedBy: expertUser?.name ?? expert.specialization,
    },
    include: newsInclude,
  });

  res.status(200).json({ success: true, draft: toWireDraft(updated) });
};

export const rejectNews = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  await expertFor(userId);
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) throw notFound('Draft', 'খসড়াটি পাওয়া যায়নি।');

  const reason = String((req.body as Record<string, unknown>)?.reason ?? '').trim();
  if (reason.length < 3) {
    throw new AppError(
      400,
      'validation_error',
      'A rejection reason is required',
      [{ field: 'reason', message: 'A rejection reason is required', message_bn: 'প্রত্যাখ্যানের কারণ লিখুন।' }],
      'প্রত্যাখ্যানের কারণ লিখুন।',
    );
  }

  const existing = await prisma.newsItem.findUnique({ where: { id } });
  if (!existing) throw notFound('Draft', 'খসড়াটি পাওয়া যায়নি।');

  const updated = await prisma.newsItem.update({
    where: { id },
    data: { status: 'ARCHIVED', advisedActionBn: `প্রত্যাখ্যাত: ${reason}` },
    include: newsInclude,
  });

  res.status(200).json({ success: true, draft: toWireDraft(updated) });
};

export const suggestNewsSource = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (name.length < 2 || !/^https?:\/\//i.test(url)) {
    throw new AppError(
      400,
      'validation_error',
      'A name and an http(s) url are required',
      [{ field: 'url', message: 'A name and an http(s) url are required', message_bn: 'সঠিক নাম ও লিংক দিন।' }],
      'সঠিক নাম ও লিংক দিন।',
    );
  }

  const suggestion = await prisma.newsSourceSuggestion.create({
    data: {
      expertId: expert.id,
      name,
      url,
      note: typeof body.note === 'string' ? body.note.trim() : null,
    },
  });

  res.status(201).json({
    success: true,
    suggestion: { id: suggestion.id, name: suggestion.name, url: suggestion.url, status: suggestion.status },
  });
};

// ---------------------------------------------------------------------------
// Knowledge base — the live RAG corpus
// ---------------------------------------------------------------------------

interface ChunkRow {
  id: string;
  chunk_id: string;
  crop: string;
  disease: string;
  disease_bn: string;
  disease_id: string | null;
  content: string;
  metadata: unknown;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toWireKnowledge(row: ChunkRow) {
  const metadata = metadataRecord(row.metadata);
  const sources = Array.isArray(metadata.sources)
    ? metadata.sources.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    id: row.id,
    chunk_id: row.chunk_id,
    disease_id: row.disease_id ?? row.chunk_id,
    disease_name: row.disease_bn || row.disease,
    crop: row.crop,
    protocol_bn: row.content,
    source: sources[0] ?? '',
    safety_note_bn: typeof metadata.safety_note_bn === 'string' ? metadata.safety_note_bn : '',
    version: typeof metadata.version === 'number' ? metadata.version : 1,
    updated_at:
      typeof metadata.updated_at === 'string' ? metadata.updated_at : new Date().toISOString(),
    reindex_queued: false,
  };
}

/**
 * Reads `knowledge_chunks` — the same table retrieval queries — rather than the
 * legacy `KnowledgeBase` model, so an expert is looking at what the AI actually
 * answers from.
 */
export const getKnowledge = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  await expertFor(userId);

  const query = typeof req.query.query === 'string' ? req.query.query.trim().toLowerCase() : '';

  const rows = await prisma.$queryRaw<ChunkRow[]>`
    SELECT id, chunk_id, crop, disease, disease_bn, disease_id, content, metadata
    FROM knowledge_chunks
    WHERE ${query}::text = ''
       OR lower(disease) LIKE ${'%' + query + '%'}
       OR lower(disease_bn) LIKE ${'%' + query + '%'}
       OR lower(crop) LIKE ${'%' + query + '%'}
    ORDER BY crop, disease
    LIMIT 200
  `;

  res.status(200).json({ success: true, entries: rows.map(toWireKnowledge) });
};

/**
 * Saving rewrites the chunk and re-embeds it immediately, so the next leaf scan
 * retrieves the new text. The embedding is the reason this is not a plain
 * Prisma update: Prisma cannot write a `vector` column.
 */
export const saveKnowledge = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const chunkId = typeof body.chunk_id === 'string' ? body.chunk_id.trim() : '';
  const protocolBn = typeof body.protocol_bn === 'string' ? body.protocol_bn.trim() : '';
  if (!chunkId) throw notFound('Protocol', 'প্রোটোকল পাওয়া যায়নি।');
  if (protocolBn.length < 20) {
    throw new AppError(
      400,
      'validation_error',
      'A treatment protocol of at least 20 characters is required',
      [{ field: 'protocol_bn', message: 'Protocol is too short', message_bn: 'চিকিৎসার বিবরণ বিস্তারিত লিখুন।' }],
      'চিকিৎসার বিবরণ বিস্তারিত লিখুন।',
    );
  }

  const rows = await prisma.$queryRaw<ChunkRow[]>`
    SELECT id, chunk_id, crop, disease, disease_bn, disease_id, content, metadata
    FROM knowledge_chunks
    WHERE chunk_id = ${chunkId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw notFound('Protocol', 'প্রোটোকল পাওয়া যায়নি।');

  // Embedding is the expensive, failure-prone half. Doing it before the write
  // means a Gemini outage leaves the old, still-correct protocol in place
  // instead of a new text with a stale vector.
  let embedding: number[];
  try {
    embedding = await getEmbedding(`${row.crop} ${row.disease} ${row.disease_bn} ${protocolBn}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new AppError(
      503,
      'embedding_unavailable',
      `Could not re-index the protocol: ${message}`,
      undefined,
      'প্রোটোকল পুনরায় সূচিবদ্ধ করা যায়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।',
    );
  }

  const previous = metadataRecord(row.metadata);
  const version = (typeof previous.version === 'number' ? previous.version : 1) + 1;
  const metadata = {
    ...previous,
    version,
    updated_at: new Date().toISOString(),
    edited_by_expert: expert.id,
    ...(typeof body.source === 'string' && body.source.trim()
      ? { sources: [body.source.trim()] }
      : {}),
    ...(typeof body.safety_note_bn === 'string' && body.safety_note_bn.trim()
      ? { safety_note_bn: body.safety_note_bn.trim() }
      : {}),
  };

  const vector = `[${embedding.join(',')}]`;
  await prisma.$executeRaw`
    UPDATE knowledge_chunks
    SET content = ${protocolBn},
        metadata = ${JSON.stringify(metadata)}::jsonb,
        embedding = ${vector}::vector
    WHERE chunk_id = ${chunkId}
  `;

  res.status(200).json({
    success: true,
    entry: toWireKnowledge({
      ...row,
      content: protocolBn,
      metadata,
    }),
  });
};

// ---------------------------------------------------------------------------
// Expert articles (authoring side)
// ---------------------------------------------------------------------------

export const getExpertArticles = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);

  const articles = await prisma.expertArticle.findMany({
    where: { expertId: expert.id },
    include: articleInclude,
    orderBy: { publishedAt: 'desc' },
  });

  res.status(200).json({
    success: true,
    articles: await Promise.all(articles.map((article) => toWireArticle(article, userId))),
  });
};

export const publishArticle = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  const content = typeof body.body === 'string' ? body.body.trim() : '';
  if (title.length < 5 || summary.length < 10 || content.length < 20) {
    throw new AppError(
      400,
      'validation_error',
      'A title, summary and body are required',
      [
        {
          field: 'title',
          message: 'A title, summary and body are required',
          message_bn: 'শিরোনাম, সারসংক্ষেপ ও বিস্তারিত লিখুন।',
        },
      ],
      'শিরোনাম, সারসংক্ষেপ ও বিস্তারিত লিখুন।',
    );
  }

  const created = await prisma.expertArticle.create({
    data: {
      title,
      summary,
      body: content,
      crop: typeof body.crop === 'string' && body.crop ? body.crop : 'rice',
      coverTone: Number.isFinite(Number(body.cover_tone)) ? Math.trunc(Number(body.cover_tone)) : 0,
      expertId: expert.id,
    },
    include: articleInclude,
  });

  res.status(201).json({ success: true, article: await toWireArticle(created, userId) });
};

export const updateArticle = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  const existing = await prisma.expertArticle.findFirst({
    where: { id, expertId: expert.id },
    select: { id: true },
  });
  if (!existing) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim();
  if (typeof body.summary === 'string' && body.summary.trim()) data.summary = body.summary.trim();
  if (typeof body.body === 'string' && body.body.trim()) data.body = body.body.trim();
  if (typeof body.crop === 'string' && body.crop) data.crop = body.crop;
  if (body.cover_tone !== undefined) data.coverTone = Math.trunc(Number(body.cover_tone)) || 0;

  if (Object.keys(data).length === 0) {
    throw new AppError(400, 'validation_error', 'Nothing to update', undefined, 'আপডেট করার কিছু নেই।');
  }

  const updated = await prisma.expertArticle.update({
    where: { id },
    data,
    include: articleInclude,
  });

  res.status(200).json({ success: true, article: await toWireArticle(updated, userId) });
};

export const deleteArticle = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  const existing = await prisma.expertArticle.findFirst({
    where: { id, expertId: expert.id },
    select: { id: true },
  });
  if (!existing) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  await prisma.expertArticle.delete({ where: { id } });
  res.status(200).json({ success: true });
};

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export const getExpertQuestions = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);

  const questions = await prisma.expertQuestion.findMany({
    where: { OR: [{ expertId: expert.id }, { expertId: null }] },
    include: questionInclude,
    orderBy: [{ urgent: 'desc' }, { createdAt: 'asc' }],
    take: 100,
  });

  res.status(200).json({ success: true, questions: questions.map(toWireQuestion) });
};

export const answerQuestion = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) throw notFound('Question', 'প্রশ্নটি পাওয়া যায়নি।');

  const reply = String((req.body as Record<string, unknown>)?.reply ?? '').trim();
  if (reply.length < 3) {
    throw new AppError(
      400,
      'validation_error',
      'A reply is required',
      [{ field: 'reply', message: 'A reply is required', message_bn: 'উত্তর লিখুন।' }],
      'উত্তর লিখুন।',
    );
  }

  const existing = await prisma.expertQuestion.findUnique({ where: { id } });
  if (!existing) throw notFound('Question', 'প্রশ্নটি পাওয়া যায়নি।');
  if (existing.status === 'ANSWERED') {
    throw new AppError(409, 'conflict', 'Already answered', undefined, 'এই প্রশ্নের উত্তর দেওয়া হয়েছে।');
  }

  const updated = await prisma.expertQuestion.update({
    where: { id },
    data: { reply, expertId: expert.id, status: 'ANSWERED', answeredAt: new Date() },
    include: questionInclude,
  });

  res.status(200).json({ success: true, question: toWireQuestion(updated) });
};

// ---------------------------------------------------------------------------
// Consultation plans and bookings
// ---------------------------------------------------------------------------

export const getConsultations = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);

  const [plans, bookings] = await Promise.all([
    prisma.consultationPlan.findMany({ where: { expertId: expert.id }, orderBy: { createdAt: 'desc' } }),
    prisma.consultationBooking.findMany({
      where: { plan: { expertId: expert.id } },
      include: { farmer: { select: { name: true } } },
      orderBy: { at: 'asc' },
      take: 100,
    }),
  ]);

  res.status(200).json({
    success: true,
    plans: plans.map((plan) => ({
      id: plan.id,
      title: plan.title,
      period: plan.period,
      price: Math.round(plan.price),
      perks: plan.perks,
      active: plan.active,
      subscribers: bookings.filter((booking) => booking.planId === plan.id).length,
    })),
    bookings: bookings.map((booking) => ({
      id: booking.id,
      farmer_name: booking.farmer?.name ?? '',
      topic: booking.topic,
      mode: booking.mode,
      at: booking.at.toISOString(),
      minutes: booking.minutes,
      status: booking.status.toLowerCase(),
    })),
  });
};

export const createPlan = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const price = Number(body.price);
  if (title.length < 3 || !Number.isFinite(price) || price < 0) {
    throw new AppError(
      400,
      'validation_error',
      'A title and a price are required',
      [{ field: 'title', message: 'A title and a price are required', message_bn: 'শিরোনাম ও মূল্য দিন।' }],
      'শিরোনাম ও মূল্য দিন।',
    );
  }

  const period = ['monthly', 'quarterly', 'yearly'].includes(String(body.period))
    ? String(body.period)
    : 'monthly';
  const perks = Array.isArray(body.perks)
    ? body.perks.filter((perk): perk is string => typeof perk === 'string' && perk.trim().length > 0)
    : [];

  const plan = await prisma.consultationPlan.create({
    data: { expertId: expert.id, title, period, price, perks },
  });

  res.status(201).json({
    success: true,
    plan: {
      id: plan.id,
      title: plan.title,
      period: plan.period,
      price: Math.round(plan.price),
      perks: plan.perks,
      active: plan.active,
      subscribers: 0,
    },
  });
};

export const togglePlan = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) throw notFound('Plan', 'পরিকল্পনাটি পাওয়া যায়নি।');

  const existing = await prisma.consultationPlan.findFirst({
    where: { id, expertId: expert.id },
    select: { id: true },
  });
  if (!existing) throw notFound('Plan', 'পরিকল্পনাটি পাওয়া যায়নি।');

  const active = (req.body as Record<string, unknown>)?.active === true;
  const plan = await prisma.consultationPlan.update({ where: { id }, data: { active } });

  res.status(200).json({
    success: true,
    plan: {
      id: plan.id,
      title: plan.title,
      period: plan.period,
      price: Math.round(plan.price),
      perks: plan.perks,
      active: plan.active,
      subscribers: 0,
    },
  });
};

export const setBookingStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) throw notFound('Booking', 'বুকিং পাওয়া যায়নি।');

  const booking = await prisma.consultationBooking.findFirst({
    where: { id, plan: { expertId: expert.id } },
    include: { farmer: { select: { name: true } } },
  });
  if (!booking) throw notFound('Booking', 'বুকিং পাওয়া যায়নি।');

  const raw = String((req.body as Record<string, unknown>)?.status ?? '').toUpperCase();
  if (!['UPCOMING', 'DONE', 'CANCELLED'].includes(raw)) {
    throw new AppError(400, 'validation_error', 'Invalid booking status', undefined, 'সঠিক স্ট্যাটাস দিন।');
  }

  const updated = await prisma.consultationBooking.update({
    where: { id },
    data: { status: raw },
    include: { farmer: { select: { name: true } } },
  });

  res.status(200).json({
    success: true,
    booking: {
      id: updated.id,
      farmer_name: updated.farmer?.name ?? '',
      topic: updated.topic,
      mode: updated.mode,
      at: updated.at.toISOString(),
      minutes: updated.minutes,
      status: updated.status.toLowerCase(),
    },
  });
};

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

export const togglePeer = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const expert = await expertFor(userId);
  const peerId = String(req.params.peerId);
  if (!UUID_PATTERN.test(peerId) || peerId === expert.id) {
    throw notFound('Expert', 'বিশেষজ্ঞ পাওয়া যায়নি।');
  }

  const peer = await prisma.expert.findUnique({
    where: { id: peerId },
    include: { user: { select: { name: true, location: true } }, _count: { select: { peerOf: true } } },
  });
  if (!peer) throw notFound('Expert', 'বিশেষজ্ঞ পাওয়া যায়নি।');

  const existing = await prisma.expertPeer.findUnique({
    where: { expertId_peerId: { expertId: expert.id, peerId } },
    select: { peerId: true },
  });

  const wirePeer = (connected: boolean) => ({
    id: peer.id,
    name: peer.user?.name ?? '',
    specialization: peer.specialization,
    district: peer.user?.location ?? '',
    rating: 0,
    followers: peer._count.peerOf,
    connected,
  });

  if (existing) {
    await prisma.expertPeer.delete({ where: { expertId_peerId: { expertId: expert.id, peerId } } });
    res.status(200).json({ success: true, connected: false, peer: wirePeer(false) });
    return;
  }

  await prisma.expertPeer.create({ data: { expertId: expert.id, peerId } });
  res.status(200).json({ success: true, connected: true, peer: wirePeer(true) });
};

// ---------------------------------------------------------------------------
// Farmer-facing: articles, questions
// ---------------------------------------------------------------------------

export const listPublicArticles = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const crop = typeof req.query.crop === 'string' ? req.query.crop.trim() : '';

  const articles = await prisma.expertArticle.findMany({
    where: {
      status: 'PUBLISHED',
      hidden: false,
      ...(crop ? { crop } : {}),
    },
    include: articleInclude,
    orderBy: { publishedAt: 'desc' },
    take: 50,
  });

  res.status(200).json({
    success: true,
    articles: await Promise.all(articles.map((article) => toWireArticle(article, userId))),
  });
};

export const getPublicArticle = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  // Reading a published article is what a view is.
  const bumped = await prisma.expertArticle.update({
    where: { id },
    data: { views: { increment: 1 } },
    include: articleInclude,
  });

  res.status(200).json({ success: true, article: await toWireArticle(bumped, userId) });
};

export const toggleArticleLike = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  const existing = await prisma.articleLike.findUnique({
    where: { articleId_userId: { articleId: id, userId } },
    select: { userId: true },
  });

  if (existing) {
    await prisma.articleLike.delete({ where: { articleId_userId: { articleId: id, userId } } });
  } else {
    await prisma.articleLike.create({ data: { articleId: id, userId } });
  }

  const article = await loadArticle(id);
  if (!article) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  res.status(200).json({ success: true, article: await toWireArticle(article, userId) });
};

export const toggleArticleSave = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  const existing = await prisma.articleSave.findUnique({
    where: { articleId_userId: { articleId: id, userId } },
    select: { userId: true },
  });

  if (existing) {
    await prisma.articleSave.delete({ where: { articleId_userId: { articleId: id, userId } } });
  } else {
    await prisma.articleSave.create({ data: { articleId: id, userId } });
  }

  const article = await loadArticle(id);
  if (!article) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  res.status(200).json({ success: true, article: await toWireArticle(article, userId) });
};

export const rateArticle = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  const rating = Math.trunc(Number((req.body as Record<string, unknown>)?.rating ?? 0));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new AppError(
      400,
      'validation_error',
      'rating must be between 1 and 5',
      [{ field: 'rating', message: 'rating must be between 1 and 5', message_bn: 'রেটিং ১ থেকে ৫ এর মধ্যে দিন।' }],
      'রেটিং ১ থেকে ৫ এর মধ্যে দিন।',
    );
  }

  await prisma.articleRating.upsert({
    where: { articleId_userId: { articleId: id, userId } },
    create: { articleId: id, userId, rating },
    update: { rating },
  });

  const article = await loadArticle(id);
  if (!article) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  res.status(200).json({ success: true, article: await toWireArticle(article, userId) });
};

export const commentOnArticle = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  const body = String((req.body as Record<string, unknown>)?.body ?? '').trim();
  if (body.length < 2) {
    throw new AppError(
      400,
      'validation_error',
      'A comment is required',
      [{ field: 'body', message: 'A comment is required', message_bn: 'মন্তব্য লিখুন।' }],
      'মন্তব্য লিখুন।',
    );
  }

  await prisma.articleComment.create({ data: { articleId: id, userId, body: body.slice(0, 1000) } });

  const article = await loadArticle(id);
  if (!article) throw notFound('Article', 'লেখাটি পাওয়া যায়নি।');

  res.status(201).json({ success: true, article: await toWireArticle(article, userId) });
};

/** A farmer asking a person. It lands in the shared queue with no expert set. */
export const askQuestion = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (question.length < 10) {
    throw new AppError(
      400,
      'validation_error',
      'A question of at least 10 characters is required',
      [{ field: 'question', message: 'Question is too short', message_bn: 'প্রশ্নটি বিস্তারিত লিখুন।' }],
      'প্রশ্নটি বিস্তারিত লিখুন।',
    );
  }

  const created = await prisma.expertQuestion.create({
    data: {
      farmerId: userId,
      crop: typeof body.crop === 'string' && body.crop ? body.crop : 'rice',
      question: question.slice(0, 2000),
      mode: ['message', 'call', 'video'].includes(String(body.mode)) ? String(body.mode) : 'message',
      urgent: body.urgent === true,
    },
    include: questionInclude,
  });

  res.status(201).json({ success: true, question: toWireQuestion(created) });
};

export const getMyQuestions = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);

  const questions = await prisma.expertQuestion.findMany({
    where: { farmerId: userId },
    include: questionInclude,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  res.status(200).json({ success: true, questions: questions.map(toWireQuestion) });
};
