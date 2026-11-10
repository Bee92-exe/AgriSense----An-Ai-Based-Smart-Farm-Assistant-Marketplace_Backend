import crypto from 'crypto';
import { Request, Response } from 'express';
import prisma from '../config/db';
import { AppError } from '../lib/errors';
import { isVendorVerified } from '../lib/serializers';
import type { AuthRequest } from '../middleware/authMiddleware';

/**
 * Haat_Bazar catalogue.
 *
 * The wire shape is snake_case because `Product.fromJson` in the app parses
 * exactly those keys; the previous camelCase payload (`stockLevel`, `vendorName`)
 * silently produced empty products on the device.
 */

type ProductWithVendor = {
  id: string;
  name: string;
  category: string;
  description: string | null;
  price: number;
  stockLevel: number;
  rating: number;
  imageUrl: string | null;
  vendorId: string;
  vendor?: {
    shopName?: string;
    verificationStatus?: string;
    rating?: number;
    user?: { name: string } | null;
  } | null;
};

export function toWireProduct(product: ProductWithVendor) {
  return {
    id: product.id,
    name: product.name,
    name_bn: null,
    category: product.category,
    price: Math.round(product.price),
    stock: product.stockLevel,
    in_stock: product.stockLevel > 0,
    description: product.description,
    image_url: product.imageUrl,
    active_ingredient: null,
    target_diseases: [] as string[],
    vendor: {
      id: product.vendorId,
      shop_name: product.vendor?.shopName ?? product.vendor?.user?.name ?? '',
      verified: isVendorVerified(product.vendor?.verificationStatus),
      rating: product.vendor?.rating ?? product.rating,
    },
  };
}

const vendorInclude = {
  vendor: { include: { user: { select: { name: true } } } },
} as const;

/** Seeds a demo catalogue once, owned by a vendor account that cannot sign in. */
const seedProducts = async (): Promise<void> => {
  const count = await prisma.product.count();
  if (count > 0) return;

  let vendor = await prisma.vendor.findFirst();
  if (!vendor) {
    let vendorUser = await prisma.user.findUnique({ where: { mobileNumber: 'system-vendor' } });
    if (!vendorUser) {
      vendorUser = await prisma.user.create({
        data: {
          name: 'AgriSense Market',
          mobileNumber: 'system-vendor',
          // Not a valid argon2 hash: this account owns the seeded catalogue and
          // is deliberately impossible to sign in to.
          passwordHash: crypto.randomBytes(48).toString('hex'),
          role: 'VENDOR',
          location: 'ঢাকা',
        },
      });
    }
    vendor = await prisma.vendor.create({
      data: {
        userId: vendorUser.id,
        shopName: 'AgriSense Official Store',
        verificationStatus: 'ACTIVE',
      },
    });
  }

  const products = [
    { name: 'বোরো ধানের বীজ (Boro Rice Seeds)', category: 'Seeds', price: 450, stockLevel: 120, rating: 4.5, description: 'উচ্চ ফলনশীল বোরো ধানের বীজ, প্রতি কেজি' },
    { name: 'ইউরিয়া সার (Urea Fertilizer)', category: 'Fertilizer', price: 1200, stockLevel: 50, rating: 4.8, description: 'সরকারি মূল্যে ইউরিয়া সার, প্রতি বস্তা' },
    { name: 'কীটনাশক স্প্রে (Pest Spray 500ml)', category: 'Pesticide', price: 600, stockLevel: 32, rating: 4.2, description: 'ফসলের পোকামাকড় দমনে কার্যকর' },
    { name: 'আমন ধানের বীজ (Aman Rice Seeds)', category: 'Seeds', price: 400, stockLevel: 85, rating: 4.0, description: 'বর্ষা মৌসুমের জন্য উপযুক্ত' },
    { name: 'DAP সার (DAP Fertilizer)', category: 'Fertilizer', price: 1500, stockLevel: 40, rating: 4.6, description: 'ফসফেট সমৃদ্ধ সার' },
    { name: 'হাত কোদাল (Hand Hoe)', category: 'Tools', price: 350, stockLevel: 25, rating: 4.3, description: 'মাটি আলগা করার জন্য উন্নত মানের কোদাল' },
    { name: 'সরিষার বীজ (Mustard Seeds)', category: 'Seeds', price: 300, stockLevel: 60, rating: 4.1, description: 'রবি মৌসুমের সরিষা বীজ' },
    { name: 'ছত্রাকনাশক (Fungicide)', category: 'Fungicide', price: 750, stockLevel: 18, rating: 4.4, description: 'ফসলের ছত্রাক রোগ দমনে কার্যকর' },
  ];

  for (const product of products) {
    await prisma.product.create({ data: { ...product, vendorId: vendor.id } });
  }
  console.log('[SEED] Products seeded successfully');
};

export const getAllProducts = async (req: Request, res: Response): Promise<void> => {
  await seedProducts();

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const text = typeof req.query.text === 'string' ? req.query.text.trim() : search;
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  const priceMin = Number(req.query.price_min ?? NaN);
  const priceMax = Number(req.query.price_max ?? NaN);
  const inStockOnly = req.query.in_stock === 'true' || req.query.in_stock === '1';
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20) || 20));

  const where = {
    ...(category && category !== 'All' ? { category } : {}),
    ...(text ? { name: { contains: text, mode: 'insensitive' as const } } : {}),
    ...(Number.isFinite(priceMin) || Number.isFinite(priceMax)
      ? {
          price: {
            ...(Number.isFinite(priceMin) ? { gte: priceMin } : {}),
            ...(Number.isFinite(priceMax) ? { lte: priceMax } : {}),
          },
        }
      : {}),
    ...(inStockOnly ? { stockLevel: { gt: 0 } } : {}),
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: vendorInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.product.count({ where }),
  ]);

  res.status(200).json({
    success: true,
    products: products.map(toWireProduct),
    pagination: { page, limit, total },
  });
};

export const getProductCategories = async (_req: Request, res: Response): Promise<void> => {
  await seedProducts();
  const rows = await prisma.product.findMany({
    distinct: ['category'],
    select: { category: true },
    orderBy: { category: 'asc' },
  });
  res.status(200).json({ success: true, categories: rows.map((row) => row.category) });
};

export const getProductById = async (req: Request, res: Response): Promise<void> => {
  const product = await prisma.product.findUnique({
    where: { id: String(req.params.id) },
    include: vendorInclude,
  });
  if (!product) {
    throw new AppError(404, 'not_found', 'Product not found', undefined, 'পণ্যটি পাওয়া যায়নি।');
  }
  res.status(200).json({ success: true, product: toWireProduct(product) });
};

/**
 * FR-16 products for a diagnosis.
 *
 * There is no curated disease-to-product mapping (a deliberate decision), so
 * this returns in-stock crop-protection items and says so in `match_reason_bn`.
 * It never claims a product treats the diagnosed disease.
 */
export const getMatchedProducts = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const diagnosis = await prisma.diagnosis.findFirst({
    where: { id: String(req.params.diagnosisId), userId },
    select: { id: true },
  });
  if (!diagnosis) {
    throw new AppError(404, 'not_found', 'Diagnosis not found', undefined, 'রোগ নির্ণয়ের তথ্য পাওয়া যায়নি।');
  }

  const products = await prisma.product.findMany({
    where: { stockLevel: { gt: 0 }, category: { in: ['Pesticide', 'Fungicide', 'Fertilizer'] } },
    include: vendorInclude,
    orderBy: { rating: 'desc' },
    take: 6,
  });

  res.status(200).json({
    success: true,
    data: products.map((product) => ({
      ...toWireProduct(product),
      match_reason_bn: 'কৃষি কর্মকর্তার পরামর্শ অনুযায়ী ব্যবহার করুন — এই তালিকা রোগভিত্তিক নয়।',
    })),
  });
};
