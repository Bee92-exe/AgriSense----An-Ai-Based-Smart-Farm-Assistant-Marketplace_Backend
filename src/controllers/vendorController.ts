import { Response } from 'express';
import prisma from '../config/db';
import { env } from '../config/env';
import { AppError } from '../lib/errors';
import type { AuthRequest } from '../middleware/authMiddleware';
import { toWireOrder } from './orderController';
import { toWireProduct } from './productController';

/**
 * The vendor's own shop.
 *
 * Every handler resolves the vendor from the session, never from an id the
 * client sends. That is the whole ownership model: a handler that skips this
 * lookup can edit another shop's catalogue, which is exactly the bug this file
 * used to have.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LOW_STOCK_THRESHOLD = 10;

/** Valid vendor transitions. Anything else is refused before a write happens. */
const TRANSITIONS: Record<string, string[]> = {
  PENDING: ['CONFIRMED', 'REJECTED'],
  CONFIRMED: ['SHIPPED'],
  SHIPPED: ['DELIVERED'],
};

async function vendorFor(userId: string) {
  const vendor = await prisma.vendor.findUnique({ where: { userId } });
  if (!vendor) {
    throw new AppError(
      403,
      'forbidden',
      'Vendor profile not found',
      undefined,
      'বিক্রেতার প্রোফাইল পাওয়া যায়নি।',
    );
  }
  return vendor;
}

function requireUser(req: AuthRequest): string {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');
  return userId;
}

function parseMoney(value: unknown, field: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new AppError(
      400,
      'validation_error',
      `${field} must be a positive number`,
      [{ field, message: `${field} must be a positive number`, message_bn: 'সঠিক মূল্য দিন।' }],
      'সঠিক মূল্য দিন।',
    );
  }
  return numeric;
}

function parseStock(value: unknown): number {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new AppError(
      400,
      'validation_error',
      'stockLevel must be zero or more',
      [{ field: 'stockLevel', message: 'stockLevel must be zero or more', message_bn: 'স্টকের পরিমাণ সঠিক নয়।' }],
      'স্টকের পরিমাণ সঠিক নয়।',
    );
  }
  return numeric;
}

const productInclude = {
  vendor: { include: { user: { select: { name: true } } } },
} as const;

const orderInclude = {
  details: { include: { product: { include: { vendor: { include: { user: { select: { name: true } } } } } } } },
  vendor: { include: { user: { select: { name: true } } } },
  events: { orderBy: { at: 'asc' } },
} as const;

/** A buyer's contact is only ever attached to the vendor's own orders. */
function toVendorOrder(
  order: Parameters<typeof toWireOrder>[0] & {
    user?: { name: string; mobileNumber: string } | null;
    deliveryAddress: string;
    note: string | null;
  },
) {
  return {
    order: toWireOrder(order),
    buyer_name: order.user?.name ?? '',
    buyer_mobile: order.user?.mobileNumber ?? '',
    buyer_district: order.deliveryAddress ?? '',
    note: order.note,
  };
}

/**
 * Dashboard, catalogue, orders and ratings in one response, so the counts on
 * the dashboard always agree with the lists behind them.
 */
export const getVendorDesk = async (req: AuthRequest, res: Response): Promise<void> => {
  const vendor = await vendorFor(requireUser(req));

  const [products, orders, ratings, ratingCount, average] = await Promise.all([
    prisma.product.findMany({
      where: { vendorId: vendor.id },
      include: productInclude,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.order.findMany({
      where: { vendorId: vendor.id },
      include: { ...orderInclude, user: { select: { name: true, mobileNumber: true } } },
      orderBy: { orderDate: 'desc' },
      take: 100,
    }),
    prisma.vendorRating.findMany({
      where: { vendorId: vendor.id },
      include: { vendor: false },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.vendorRating.count({ where: { vendorId: vendor.id } }),
    prisma.vendorRating.aggregate({ where: { vendorId: vendor.id }, _avg: { rating: true } }),
  ]);

  // Buyer names for the rating list, resolved in one query instead of N.
  const raterIds = [...new Set(ratings.map((rating) => rating.userId))];
  const raters = raterIds.length
    ? await prisma.user.findMany({
        where: { id: { in: raterIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(raters.map((rater) => [rater.id, rater.name]));

  res.status(200).json({
    success: true,
    desk: {
      products: products.map(toWireProduct),
      orders: orders.map(toVendorOrder),
      ratings: ratings.map((rating) => ({
        rating: rating.rating,
        comment: rating.comment ?? '',
        farmer_name: nameById.get(rating.userId) ?? '',
        created_at: rating.createdAt.toISOString(),
      })),
      rating_count: ratingCount,
      average_rating: average._avg.rating ?? 0,
      low_stock_threshold: LOW_STOCK_THRESHOLD,
    },
  });
};

export const getVendorProducts = async (req: AuthRequest, res: Response): Promise<void> => {
  const vendor = await vendorFor(requireUser(req));

  const products = await prisma.product.findMany({
    where: { vendorId: vendor.id },
    include: productInclude,
    orderBy: { createdAt: 'desc' },
  });

  res.status(200).json({ success: true, products: products.map(toWireProduct) });
};

export const addProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  const vendor = await vendorFor(requireUser(req));
  const body = (req.body ?? {}) as Record<string, unknown>;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 2) {
    throw new AppError(
      400,
      'validation_error',
      'A product name is required',
      [{ field: 'name', message: 'A product name is required', message_bn: 'পণ্যের নাম লিখুন।' }],
      'পণ্যের নাম লিখুন।',
    );
  }

  const category = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : 'seed';
  const price = parseMoney(body.price, 'price');
  const stockLevel = parseStock(body.stockLevel ?? body.stock ?? 0);
  const description = typeof body.description === 'string' ? body.description.trim() : null;
  const imageUrl = typeof body.imageUrl === 'string' && body.imageUrl.trim() ? body.imageUrl.trim() : null;

  const product = await prisma.product.create({
    data: { name, category, price, stockLevel, description, imageUrl, vendorId: vendor.id },
    include: productInclude,
  });

  res.status(201).json({ success: true, product: toWireProduct(product) });
};

/**
 * Ownership is the point: the update is scoped to `vendorId: vendor.id`, so a
 * farmer or a rival shop gets a 404 instead of a silent write.
 */
export const updateProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  const vendor = await vendorFor(requireUser(req));
  const productId = String(req.params.id);

  if (!UUID_PATTERN.test(productId)) {
    throw new AppError(404, 'not_found', 'Product not found', undefined, 'পণ্যটি পাওয়া যায়নি।');
  }

  const existing = await prisma.product.findFirst({
    where: { id: productId, vendorId: vendor.id },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError(404, 'not_found', 'Product not found', undefined, 'পণ্যটি পাওয়া যায়নি।');
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
  if (typeof body.category === 'string' && body.category.trim()) data.category = body.category.trim();
  if (body.price !== undefined) data.price = parseMoney(body.price, 'price');
  if (body.stockLevel !== undefined || body.stock !== undefined) {
    data.stockLevel = parseStock(body.stockLevel ?? body.stock);
  }
  if (typeof body.description === 'string') data.description = body.description.trim();
  if (typeof body.imageUrl === 'string') data.imageUrl = body.imageUrl.trim() || null;

  if (Object.keys(data).length === 0) {
    throw new AppError(400, 'validation_error', 'Nothing to update', undefined, 'আপডেট করার কিছু নেই।');
  }

  const product = await prisma.product.update({
    where: { id: productId },
    data,
    include: productInclude,
  });

  res.status(200).json({ success: true, product: toWireProduct(product) });
};

export const deleteProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  const vendor = await vendorFor(requireUser(req));
  const productId = String(req.params.id);

  if (!UUID_PATTERN.test(productId)) {
    throw new AppError(404, 'not_found', 'Product not found', undefined, 'পণ্যটি পাওয়া যায়নি।');
  }

  const existing = await prisma.product.findFirst({
    where: { id: productId, vendorId: vendor.id },
    select: { id: true, _count: { select: { orderDetails: true } } },
  });
  if (!existing) {
    throw new AppError(404, 'not_found', 'Product not found', undefined, 'পণ্যটি পাওয়া যায়নি।');
  }

  // Deleting a product that appears on an order would rewrite history and, via
  // the cascade, erase the line items of real purchases.
  if (existing._count.orderDetails > 0) {
    throw new AppError(
      409,
      'product_in_use',
      'This product appears on existing orders and cannot be deleted',
      undefined,
      'এই পণ্যটি আগের অর্ডারে আছে, তাই মুছে ফেলা যাবে না।',
    );
  }

  await prisma.product.delete({ where: { id: productId } });
  res.status(200).json({ success: true });
};

export const getVendorOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  const vendor = await vendorFor(requireUser(req));

  const orders = await prisma.order.findMany({
    where: { vendorId: vendor.id },
    include: { ...orderInclude, user: { select: { name: true, mobileNumber: true } } },
    orderBy: { orderDate: 'desc' },
    take: 200,
  });

  res.status(200).json({ success: true, orders: orders.map(toVendorOrder) });
};

/**
 * A vendor may only move its own order, and only along a valid edge. Stock is
 * returned when an order is rejected, so a refusal does not leave a phantom
 * sale holding inventory.
 */
export const updateOrderStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const vendor = await vendorFor(requireUser(req));
  const orderId = String(req.params.id);

  if (!UUID_PATTERN.test(orderId)) {
    throw new AppError(404, 'not_found', 'Order not found', undefined, 'অর্ডারটি পাওয়া যায়নি।');
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const next = String(body.status ?? '').trim().toUpperCase();
  if (!next) {
    throw new AppError(400, 'validation_error', 'A status is required', undefined, 'স্ট্যাটাস দিন।');
  }

  const order = await prisma.order.findFirst({
    where: { id: orderId, vendorId: vendor.id },
    include: orderInclude,
  });
  if (!order) {
    throw new AppError(404, 'not_found', 'Order not found', undefined, 'অর্ডারটি পাওয়া যায়নি।');
  }

  const allowed = TRANSITIONS[order.status] ?? [];
  if (!allowed.includes(next)) {
    throw new AppError(
      409,
      'invalid_transition',
      `Cannot move an order from ${order.status} to ${next}`,
      undefined,
      'এই অর্ডারটি এই ধাপে পরিবর্তন করা যাবে না।',
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { status: next } });
    await tx.orderEvent.create({ data: { orderId: order.id, status: next } });

    if (next === 'REJECTED') {
      for (const detail of order.details) {
        await tx.product.update({
          where: { id: detail.productId },
          data: { stockLevel: { increment: detail.quantity } },
        });
      }
    }

    return tx.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { ...orderInclude, user: { select: { name: true, mobileNumber: true } } },
    });
  });

  res.status(200).json({ success: true, order: toVendorOrder(updated) });
};

export const getVendorStats = async (req: AuthRequest, res: Response): Promise<void> => {
  const vendor = await vendorFor(requireUser(req));

  const since = new Date();
  since.setDate(since.getDate() - 30);

  const [totalProducts, lowStockProducts, pendingOrders, details] = await Promise.all([
    prisma.product.count({ where: { vendorId: vendor.id } }),
    prisma.product.count({
      where: { vendorId: vendor.id, stockLevel: { gt: 0, lte: LOW_STOCK_THRESHOLD } },
    }),
    prisma.order.count({ where: { vendorId: vendor.id, status: 'PENDING' } }),
    prisma.orderDetail.findMany({
      where: { product: { vendorId: vendor.id } },
      include: { order: { select: { status: true, orderDate: true } } },
    }),
  ]);

  const live = details.filter(
    (detail) => detail.order.status !== 'CANCELLED' && detail.order.status !== 'REJECTED',
  );
  const totalRevenue = live.reduce((sum, detail) => sum + detail.subtotal, 0);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todaySales = live
    .filter((detail) => detail.order.orderDate >= startOfToday)
    .reduce((sum, detail) => sum + detail.subtotal, 0);

  res.status(200).json({
    success: true,
    stats: {
      totalProducts,
      lowStockProducts,
      pendingOrders,
      totalRevenue: Math.round(totalRevenue),
      todaySales: Math.round(todaySales),
    },
  });
};

type CustomerRow = {
  id: string;
  name: string;
  mobile: string;
  district: string;
  orders: number;
  totalSpent: number;
  lastOrderAt: Date;
  segment: string;
  note: string | null;
  followUp: boolean;
};

/** Segments are derived from the order history, not stored, so they cannot drift. */
function segmentFor(orders: number, lastOrderAt: Date): string {
  const daysSince = (Date.now() - lastOrderAt.getTime()) / 86_400_000;
  if (daysSince > 60) return 'atRisk';
  if (orders >= 4) return 'loyal';
  if (orders >= 2) return 'repeat';
  return 'new';
}

/**
 * Money, top sellers, the customer book and payouts.
 *
 * Every figure is derived from real order rows. Commission uses the configured
 * platform percentage; the payout balance is what has been earned minus what
 * has already been paid out.
 */
export const getVendorBusiness = async (req: AuthRequest, res: Response): Promise<void> => {
  const vendor = await vendorFor(requireUser(req));

  const since = new Date();
  since.setDate(since.getDate() - 30);
  const weekStart = new Date();
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - 6);

  const [orders, payouts, visits30] = await Promise.all([
    prisma.order.findMany({
      where: { vendorId: vendor.id },
      include: {
        details: { include: { product: { select: { id: true, name: true } } } },
        user: { select: { id: true, name: true, mobileNumber: true, location: true } },
      },
      orderBy: { orderDate: 'desc' },
    }),
    prisma.vendorPayout.findMany({ where: { vendorId: vendor.id }, orderBy: { createdAt: 'desc' }, take: 24 }),
    prisma.vendorVisit.count({ where: { vendorId: vendor.id, at: { gte: since } } }),
  ]);

  const live = orders.filter((order) => order.status !== 'CANCELLED' && order.status !== 'REJECTED');
  const in30 = live.filter((order) => order.orderDate >= since);

  const revenue30 = in30.reduce(
    (sum, order) => sum + order.details.reduce((lineSum, detail) => lineSum + detail.subtotal, 0),
    0,
  );
  const commissionPercent = env.PLATFORM_COMMISSION_PERCENT;
  const commission30 = (revenue30 * commissionPercent) / 100;
  const profit30 = revenue30 - commission30;

  const totalEarned = live.reduce(
    (sum, order) => sum + order.details.reduce((lineSum, detail) => lineSum + detail.subtotal, 0),
    0,
  );
  const paidOut = payouts
    .filter((payout) => payout.status === 'PAID')
    .reduce((sum, payout) => sum + payout.amount, 0);
  const pendingPayout = Math.max(0, totalEarned - paidOut);

  // Seven buckets, oldest first, so a quiet day is a zero rather than a gap.
  const week = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + index);
    const next = new Date(day);
    next.setDate(day.getDate() + 1);
    const value = live
      .filter((order) => order.orderDate >= day && order.orderDate < next)
      .reduce((sum, order) => sum + order.details.reduce((lineSum, d) => lineSum + d.subtotal, 0), 0);
    return { day: day.toISOString(), value: Math.round(value) };
  });

  const byProduct = new Map<string, { name: string; units: number; revenue: number }>();
  for (const order of in30) {
    for (const detail of order.details) {
      const key = detail.productId;
      const entry = byProduct.get(key) ?? {
        name: detail.product?.name ?? 'Unknown',
        units: 0,
        revenue: 0,
      };
      entry.units += detail.quantity;
      entry.revenue += detail.subtotal;
      byProduct.set(key, entry);
    }
  }
  const topProducts = [...byProduct.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map((entry) => ({ name: entry.name, units: entry.units, revenue: Math.round(entry.revenue) }));

  const notes = await prisma.vendorCustomerNote.findMany({ where: { vendorId: vendor.id } });
  const noteByCustomer = new Map(notes.map((note) => [note.customerId, note]));

  const byCustomer = new Map<string, CustomerRow>();
  for (const order of live) {
    if (!order.user) continue;
    const existing = byCustomer.get(order.user.id);
    const orderTotal = order.details.reduce((sum, detail) => sum + detail.subtotal, 0);
    if (existing) {
      existing.orders += 1;
      existing.totalSpent += orderTotal;
      if (order.orderDate > existing.lastOrderAt) existing.lastOrderAt = order.orderDate;
      continue;
    }
    const note = noteByCustomer.get(order.user.id);
    byCustomer.set(order.user.id, {
      id: order.user.id,
      name: order.user.name,
      mobile: order.user.mobileNumber,
      district: order.user.location ?? '',
      orders: 1,
      totalSpent: orderTotal,
      lastOrderAt: order.orderDate,
      segment: 'new',
      note: note?.note ?? null,
      followUp: note?.followUp ?? false,
    });
  }

  const customers = [...byCustomer.values()]
    .map((customer) => ({
      id: customer.id,
      name: customer.name,
      mobile: customer.mobile,
      district: customer.district,
      orders: customer.orders,
      total_spent: Math.round(customer.totalSpent),
      last_order_at: customer.lastOrderAt.toISOString(),
      segment: segmentFor(customer.orders, customer.lastOrderAt),
      note: customer.note,
      follow_up: customer.followUp,
    }))
    .sort((a, b) => b.total_spent - a.total_spent);

  res.status(200).json({
    success: true,
    business: {
      week,
      revenue30: Math.round(revenue30),
      profit30: Math.round(profit30),
      commission30: Math.round(commission30),
      commission_percent: commissionPercent,
      pending_payout: Math.round(pendingPayout),
      store_visits: visits30,
      orders30: in30.length,
      payouts: payouts.map((payout) => ({
        id: payout.id,
        amount: Math.round(payout.amount),
        at: (payout.paidAt ?? payout.createdAt).toISOString(),
        status: payout.status.toLowerCase(),
        reference: payout.reference,
      })),
      top_products: topProducts,
      customers,
    },
  });
};

/** Recomputes one buyer's summary so a note save can return the whole row. */
async function customerSummary(vendorId: string, customerId: string) {
  const [orders, note] = await Promise.all([
    prisma.order.findMany({
      where: { vendorId, userId: customerId, status: { notIn: ['CANCELLED', 'REJECTED'] } },
      include: { details: { select: { subtotal: true } } },
      orderBy: { orderDate: 'desc' },
    }),
    prisma.vendorCustomerNote.findUnique({
      where: { vendorId_customerId: { vendorId, customerId } },
    }),
  ]);

  const user = await prisma.user.findUnique({
    where: { id: customerId },
    select: { id: true, name: true, mobileNumber: true, location: true },
  });

  const totalSpent = orders.reduce(
    (sum, order) => sum + order.details.reduce((lineSum, detail) => lineSum + detail.subtotal, 0),
    0,
  );
  const lastOrderAt = orders[0]?.orderDate ?? new Date();

  return {
    id: customerId,
    name: user?.name ?? '',
    mobile: user?.mobileNumber ?? '',
    district: user?.location ?? '',
    orders: orders.length,
    total_spent: Math.round(totalSpent),
    last_order_at: lastOrderAt.toISOString(),
    segment: segmentFor(orders.length, lastOrderAt),
    note: note?.note ?? null,
    follow_up: note?.followUp ?? false,
  };
}

export const saveCustomerNote = async (req: AuthRequest, res: Response): Promise<void> => {
  const vendor = await vendorFor(requireUser(req));
  const customerId = String(req.params.customerId);

  if (!UUID_PATTERN.test(customerId)) {
    throw new AppError(404, 'not_found', 'Customer not found', undefined, 'ক্রেতা পাওয়া যায়নি।');
  }

  // A vendor may only keep notes about someone who actually bought from them.
  const hasOrder = await prisma.order.findFirst({
    where: { vendorId: vendor.id, userId: customerId },
    select: { id: true },
  });
  if (!hasOrder) {
    throw new AppError(404, 'not_found', 'Customer not found', undefined, 'ক্রেতা পাওয়া যায়নি।');
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';

  const saved = await prisma.vendorCustomerNote.upsert({
    where: { vendorId_customerId: { vendorId: vendor.id, customerId } },
    create: { vendorId: vendor.id, customerId, note },
    update: { note },
  });

  res.status(200).json({
    success: true,
    customer: await customerSummary(vendor.id, customerId),
    note: saved.note,
  });
};

export const setFollowUp = async (req: AuthRequest, res: Response): Promise<void> => {
  const vendor = await vendorFor(requireUser(req));
  const customerId = String(req.params.customerId);

  if (!UUID_PATTERN.test(customerId)) {
    throw new AppError(404, 'not_found', 'Customer not found', undefined, 'ক্রেতা পাওয়া যায়নি।');
  }

  const hasOrder = await prisma.order.findFirst({
    where: { vendorId: vendor.id, userId: customerId },
    select: { id: true },
  });
  if (!hasOrder) {
    throw new AppError(404, 'not_found', 'Customer not found', undefined, 'ক্রেতা পাওয়া যায়নি।');
  }

  const followUp = (req.body as Record<string, unknown>)?.followUp === true;

  const saved = await prisma.vendorCustomerNote.upsert({
    where: { vendorId_customerId: { vendorId: vendor.id, customerId } },
    create: { vendorId: vendor.id, customerId, note: '', followUp },
    update: { followUp },
  });

  res.status(200).json({
    success: true,
    customer: await customerSummary(vendor.id, customerId),
    note: saved.note,
  });
};

/** Analytics event: a farmer opened this shop's storefront. */
export const recordVendorVisit = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = requireUser(req);
  const vendorId = String(req.params.id);

  if (!UUID_PATTERN.test(vendorId)) {
    throw new AppError(404, 'not_found', 'Vendor not found', undefined, 'বিক্রেতা পাওয়া যায়নি।');
  }

  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
  if (!vendor) {
    throw new AppError(404, 'not_found', 'Vendor not found', undefined, 'বিক্রেতা পাওয়া যায়নি।');
  }

  await prisma.vendorVisit.create({ data: { vendorId, userId } });
  res.status(201).json({ success: true });
};
