import crypto from 'crypto';
import { Response } from 'express';
import prisma from '../config/db';
import { AppError } from '../lib/errors';
import { isVendorVerified } from '../lib/serializers';
import type { AuthRequest } from '../middleware/authMiddleware';

/**
 * Orders.
 *
 * A basket is single-vendor and the server owns every price (T-D3): the client
 * sends product ids and quantities only, so a tampered price is impossible.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const orderInclude = {
  details: { include: { product: { include: { vendor: { include: { user: { select: { name: true } } } } } } } },
  vendor: { include: { user: { select: { name: true } } } },
  events: { orderBy: { at: 'asc' } },
} as const;

type OrderRecord = {
  id: string;
  orderNo: string | null;
  orderDate: Date;
  status: string;
  totalAmount: number;
  paymentMethod: string;
  placedVia: string;
  note: string | null;
  details: Array<{
    productId: string;
    quantity: number;
    subtotal: number;
    product?: { name: string } | null;
  }>;
  vendor?: {
    id: string;
    shopName: string;
    verificationStatus: string;
    rating: number;
    user?: { name: string } | null;
  } | null;
  events?: Array<{ status: string; at: Date }>;
};

function orderNumber(order: { id: string; orderDate: Date; orderNo: string | null }): string {
  if (order.orderNo) return order.orderNo;
  const day = order.orderDate.toISOString().slice(0, 10).replace(/-/g, '');
  return `AG-${day}-${order.id.slice(0, 6).toUpperCase()}`;
}

export function toWireOrder(order: OrderRecord) {
  const vendor = order.vendor;
  return {
    id: order.id,
    order_no: orderNumber({ id: order.id, orderDate: order.orderDate, orderNo: order.orderNo }),
    status: order.status.toLowerCase(),
    // Decision A4: the farmer UI folds `confirmed` into `pending`.
    display_status: order.status === 'CONFIRMED' ? 'pending' : order.status.toLowerCase(),
    payment_mode: order.paymentMethod.toLowerCase() === 'direct' ? 'direct' : 'cod',
    placed_via: order.placedVia === 'voice' ? 'voice' : 'touch',
    total_amount: Math.round(order.totalAmount),
    items: order.details.map((detail) => {
      const quantity = Math.max(1, detail.quantity);
      return {
        product_id: detail.productId,
        name: detail.product?.name ?? '',
        quantity: detail.quantity,
        unit_price: Math.round(detail.subtotal / quantity),
        subtotal: Math.round(detail.subtotal),
      };
    }),
    vendor: {
      id: vendor?.id ?? '',
      shop_name: vendor?.shopName ?? vendor?.user?.name ?? '',
      verified: isVendorVerified(vendor?.verificationStatus),
      rating: vendor?.rating ?? 0,
    },
    history: (order.events ?? []).map((event) => ({
      status: event.status.toLowerCase(),
      at: event.at.toISOString(),
    })),
    note: order.note,
    created_at: order.orderDate.toISOString(),
  };
}

function parseItems(raw: unknown): Array<{ productId: string; quantity: number }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(
      400,
      'validation_error',
      'No items in cart',
      [{ field: 'items', message: 'No items in cart', message_bn: 'কার্টে কোনো পণ্য নেই।' }],
      'কার্টে কোনো পণ্য নেই।',
    );
  }

  return raw.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const productId = String(record.product_id ?? record.productId ?? '').trim();
    const quantity = Math.trunc(Number(record.quantity ?? 0));
    if (!UUID_PATTERN.test(productId)) {
      throw new AppError(400, 'validation_error', 'Invalid product id', undefined, 'পণ্যের আইডি সঠিক নয়।');
    }
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 1000) {
      throw new AppError(400, 'validation_error', 'Invalid quantity', undefined, 'পরিমাণ সঠিক নয়।');
    }
    return { productId, quantity };
  });
}

export const createOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const body = (req.body ?? {}) as Record<string, unknown>;
  const items = parseItems(body.items);

  const rawClientUuid = String(body.client_uuid ?? body.clientUuid ?? '').trim();
  const clientUuid = rawClientUuid || null;
  if (clientUuid && !UUID_PATTERN.test(clientUuid)) {
    throw new AppError(400, 'validation_error', 'client_uuid must be a UUID', undefined, 'অর্ডার আইডি সঠিক নয়।');
  }

  // A retry of the same tap must not place a second order.
  if (clientUuid) {
    const existing = await prisma.order.findUnique({ where: { clientUuid }, include: orderInclude });
    if (existing) {
      if (existing.userId !== userId) {
        throw new AppError(409, 'conflict', 'This order id belongs to another account', undefined, 'এই অর্ডার আইডি অন্য অ্যাকাউন্টের।');
      }
      res.status(200).json({ success: true, order: toWireOrder(existing) });
      return;
    }
  }

  const products = await prisma.product.findMany({
    where: { id: { in: items.map((item) => item.productId) } },
  });
  if (products.length !== items.length) {
    throw new AppError(400, 'validation_error', 'A product in the cart no longer exists', undefined, 'কার্টের একটি পণ্য আর পাওয়া যাচ্ছে না।');
  }

  const vendorIds = new Set(products.map((product) => product.vendorId));
  if (vendorIds.size > 1) {
    throw new AppError(
      409,
      'mixed_vendor',
      'One order can only contain products from one vendor',
      undefined,
      'একটি অর্ডারে একই বিক্রেতার পণ্য থাকতে হবে।',
    );
  }

  const byId = new Map(products.map((product) => [product.id, product]));
  for (const item of items) {
    const product = byId.get(item.productId);
    if (!product) continue;
    if (product.stockLevel < item.quantity) {
      throw new AppError(
        409,
        'insufficient_stock',
        `Not enough stock for ${product.name}`,
        [{ field: 'items', message: 'Not enough stock', message_bn: 'যথেষ্ট স্টক নেই।' }],
        `${product.name} এর যথেষ্ট স্টক নেই।`,
      );
    }
  }

  const totalAmount = items.reduce((sum, item) => {
    const product = byId.get(item.productId);
    return sum + (product ? product.price * item.quantity : 0);
  }, 0);

  const profile = await prisma.user.findUnique({ where: { id: userId }, select: { location: true } });
  const deliveryAddress =
    typeof body.delivery_address === 'string' && body.delivery_address.trim()
      ? body.delivery_address.trim()
      : profile?.location?.trim() || 'ঠিকানা দেওয়া হয়নি';

  const paymentMode = String(body.payment_mode ?? 'cod').toLowerCase() === 'direct' ? 'direct' : 'cod';
  const placedVia = String(body.placed_via ?? 'touch').toLowerCase() === 'voice' ? 'voice' : 'touch';
  const vendorId = products[0]?.vendorId ?? null;

  const created = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        orderNo: `AG-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto
          .randomBytes(2)
          .toString('hex')
          .toUpperCase()}`,
        userId,
        vendorId,
        totalAmount,
        paymentMethod: paymentMode,
        deliveryAddress,
        placedVia,
        note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
        clientUuid,
        details: {
          create: items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            subtotal: (byId.get(item.productId)?.price ?? 0) * item.quantity,
          })),
        },
        events: { create: [{ status: 'PENDING' }] },
      },
    });

    for (const item of items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stockLevel: { decrement: item.quantity } },
      });
    }

    return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  });

  res.status(201).json({ success: true, order: toWireOrder(created) });
};

function statusFilter(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : '';
  const allowed = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'REJECTED', 'CANCELLED'];
  return allowed.includes(raw) ? raw : undefined;
}

export const getMyOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const orders = await prisma.order.findMany({
    where: { userId, ...(statusFilter(req.query.status) ? { status: statusFilter(req.query.status)! } : {}) },
    include: orderInclude,
    orderBy: { orderDate: 'desc' },
    take: 100,
  });

  res.status(200).json({ success: true, orders: orders.map(toWireOrder) });
};

async function ownedOrder(userId: string, orderId: string) {
  if (!UUID_PATTERN.test(orderId)) {
    throw new AppError(404, 'not_found', 'Order not found', undefined, 'অর্ডারটি পাওয়া যায়নি।');
  }
  const order = await prisma.order.findFirst({ where: { id: orderId, userId }, include: orderInclude });
  if (!order) {
    throw new AppError(404, 'not_found', 'Order not found', undefined, 'অর্ডারটি পাওয়া যায়নি।');
  }
  return order;
}

export const getOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');
  const order = await ownedOrder(userId, String(req.params.id));
  res.status(200).json({ success: true, order: toWireOrder(order) });
};

export const cancelOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');
  const order = await ownedOrder(userId, String(req.params.id));

  if (order.status !== 'PENDING') {
    throw new AppError(
      409,
      'invalid_transition',
      'Only a pending order can be cancelled',
      undefined,
      'শুধু অপেক্ষমাণ অর্ডার বাতিল করা যায়।',
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
    await tx.orderEvent.create({ data: { orderId: order.id, status: 'CANCELLED' } });
    // Stock goes back: a cancelled order must not leave a phantom sale.
    for (const detail of order.details) {
      await tx.product.update({
        where: { id: detail.productId },
        data: { stockLevel: { increment: detail.quantity } },
      });
    }
    return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  });

  res.status(200).json({ success: true, order: toWireOrder(updated) });
};

export const getInvoice = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');
  const order = await ownedOrder(userId, String(req.params.id));
  const wire = toWireOrder(order);

  res.status(200).json({
    success: true,
    invoice: {
      order_no: wire.order_no,
      issued_at: wire.created_at,
      items: wire.items,
      total_amount: wire.total_amount,
      vendor_shop_name: wire.vendor.shop_name,
    },
  });
};

/** FR-26. One rating per farmer per vendor, with the vendor average recomputed. */
export const rateVendor = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const vendorId = String(req.params.id);
  if (!UUID_PATTERN.test(vendorId)) {
    throw new AppError(404, 'not_found', 'Vendor not found', undefined, 'বিক্রেতা পাওয়া যায়নি।');
  }

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
  const rawComment = (req.body as Record<string, unknown>)?.comment;
  const comment = typeof rawComment === 'string' && rawComment.trim() ? rawComment.trim().slice(0, 500) : null;

  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
  if (!vendor) {
    throw new AppError(404, 'not_found', 'Vendor not found', undefined, 'বিক্রেতা পাওয়া যায়নি।');
  }

  await prisma.vendorRating.upsert({
    where: { vendorId_userId: { vendorId, userId } },
    create: { vendorId, userId, rating, comment },
    update: { rating, comment },
  });

  const aggregate = await prisma.vendorRating.aggregate({
    where: { vendorId },
    _avg: { rating: true },
    _count: { rating: true },
  });

  await prisma.vendor.update({
    where: { id: vendorId },
    data: { rating: aggregate._avg.rating ?? 0, ratingCount: aggregate._count.rating },
  });

  res.status(200).json({
    success: true,
    rating: { average: aggregate._avg.rating ?? 0, count: aggregate._count.rating },
  });
};
