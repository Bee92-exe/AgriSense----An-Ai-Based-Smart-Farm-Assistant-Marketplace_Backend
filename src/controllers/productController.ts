import crypto from 'crypto';
import { Request, Response } from 'express';
import prisma from '../config/db';
import { AuthRequest } from '../middleware/authMiddleware';

// Seed products into DB if empty (runs once on first request)
const seedProducts = async () => {
  const count = await prisma.product.count();
  if (count > 0) return;

  // We need at least one vendor. Create a system vendor if none exists.
  let vendor = await prisma.vendor.findFirst();
  if (!vendor) {
    // Check if a system vendor user exists
    let vendorUser = await prisma.user.findUnique({ where: { mobileNumber: 'system-vendor' } });
    if (!vendorUser) {
      vendorUser = await prisma.user.create({
        data: {
          name: 'AgriSense Market',
          mobileNumber: 'system-vendor',
          // Not a valid argon2 hash: this account exists to own the seeded
          // catalogue and is deliberately impossible to sign in to.
          passwordHash: crypto.randomBytes(48).toString('hex'),
          role: 'VENDOR',
          location: 'ঢাকা',
        }
      });
    }
    vendor = await prisma.vendor.create({
      data: {
        userId: vendorUser.id,
        shopName: 'AgriSense Official Store',
      }
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
    { name: 'ছত্রাকনাশক (Fungicide)', category: 'Pesticide', price: 750, stockLevel: 18, rating: 4.4, description: 'ফসলের ছত্রাক রোগ দমনে কার্যকর' },
  ];

  for (const p of products) {
    await prisma.product.create({
      data: {
        ...p,
        vendorId: vendor.id,
      }
    });
  }
  console.log('[SEED] Products seeded successfully');
};

export const getAllProducts = async (req: Request, res: Response): Promise<void> => {
  try {
    await seedProducts();

    const category = req.query.category as string | undefined;
    const search = req.query.search as string | undefined;
    
    let where: any = {};
    if (category && category !== 'All') {
      where.category = category;
    }
    if (search) {
      where.name = { contains: search };
    }

    const products = await prisma.product.findMany({
      where,
      include: {
        vendor: {
          include: { user: { select: { name: true } } }
        }
      },
      orderBy: { createdAt: 'desc' },
    });

    const mapped = products.map(p => ({
      id: p.id,
      name: p.name,
      category: p.category,
      price: p.price,
      rating: p.rating,
      stockLevel: p.stockLevel,
      description: p.description,
      imageUrl: p.imageUrl,
      vendorName: p.vendor?.user?.name || p.vendor?.shopName || 'Unknown',
    }));

    res.status(200).json({ success: true, products: mapped });
  } catch (error: any) {
    console.error('Products Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch products' });
  }
};

export const getProductById = async (req: Request, res: Response): Promise<void> => {
  try {
    const productId = req.params.id as string;
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        vendor: {
          include: { user: { select: { name: true, location: true } } }
        }
      },
    });

    if (!product) {
      res.status(404).json({ success: false, message: 'Product not found' });
      return;
    }

    const vendorData = product as any;
    res.status(200).json({
      success: true,
      product: {
        id: product.id,
        name: product.name,
        category: product.category,
        price: product.price,
        rating: product.rating,
        stockLevel: product.stockLevel,
        description: product.description,
        imageUrl: product.imageUrl,
        vendorName: vendorData.vendor?.user?.name || vendorData.vendor?.shopName || 'Unknown',
        vendorLocation: vendorData.vendor?.user?.location || '',
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch product' });
  }
};

export const createOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const { items, deliveryAddress, paymentMethod } = req.body;
    // items: [{ productId, quantity }]

    if (!items || items.length === 0) {
      res.status(400).json({ success: false, message: 'No items in cart' });
      return;
    }

    // Calculate totals
    let totalAmount = 0;
    const orderDetails: { productId: string; quantity: number; subtotal: number }[] = [];

    for (const item of items) {
      const product = await prisma.product.findUnique({ where: { id: item.productId } });
      if (!product) {
        res.status(400).json({ success: false, message: `Product ${item.productId} not found` });
        return;
      }
      const subtotal = product.price * item.quantity;
      totalAmount += subtotal;
      orderDetails.push({ productId: item.productId, quantity: item.quantity, subtotal });
    }

    const order = await prisma.order.create({
      data: {
        userId,
        totalAmount,
        paymentMethod: paymentMethod || 'Cash on Delivery',
        deliveryAddress: deliveryAddress || 'Not specified',
        details: {
          create: orderDetails,
        }
      },
      include: { details: true },
    });

    // Decrease stock levels
    for (const item of items) {
      await prisma.product.update({
        where: { id: item.productId },
        data: { stockLevel: { decrement: item.quantity } },
      });
    }

    res.status(201).json({ success: true, order });
  } catch (error: any) {
    console.error('Order Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to create order' });
  }
};

export const getMyOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const orders = await prisma.order.findMany({
      where: { userId },
      include: {
        details: {
          include: { product: true }
        }
      },
      orderBy: { orderDate: 'desc' },
    });

    res.status(200).json({ success: true, orders });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch orders' });
  }
};
