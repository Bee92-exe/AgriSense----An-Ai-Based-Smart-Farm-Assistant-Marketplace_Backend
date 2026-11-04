import { Request, Response } from 'express';
import prisma from '../config/db';
import { AuthRequest } from '../middleware/authMiddleware';

// Get vendor's own products
export const getVendorProducts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

    const vendor = await prisma.vendor.findUnique({ where: { userId } });
    if (!vendor) { res.status(403).json({ success: false, message: 'Not a vendor' }); return; }

    const products = await prisma.product.findMany({
      where: { vendorId: vendor.id },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json({ success: true, products });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch vendor products' });
  }
};

// Add a new product
export const addProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

    const vendor = await prisma.vendor.findUnique({ where: { userId } });
    if (!vendor) { res.status(403).json({ success: false, message: 'Not a vendor' }); return; }

    const { name, category, price, stockLevel, description } = req.body;

    const product = await prisma.product.create({
      data: {
        name,
        category: category || 'Seeds',
        price: parseFloat(price),
        stockLevel: parseInt(stockLevel) || 0,
        description: description || '',
        vendorId: vendor.id,
      }
    });

    res.status(201).json({ success: true, product });
  } catch (error: any) {
    console.error('Add Product Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to add product' });
  }
};

// Update product stock/price
export const updateProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const productId = req.params.id as string;
    if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

    const { name, price, stockLevel, description, category } = req.body;

    const product = await prisma.product.update({
      where: { id: productId },
      data: {
        ...(name && { name }),
        ...(price && { price: parseFloat(price) }),
        ...(stockLevel !== undefined && { stockLevel: parseInt(stockLevel) }),
        ...(description && { description }),
        ...(category && { category }),
      }
    });

    res.status(200).json({ success: true, product });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to update product' });
  }
};

// Get orders for vendor's products
export const getVendorOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

    const vendor = await prisma.vendor.findUnique({ where: { userId } });
    if (!vendor) { res.status(403).json({ success: false, message: 'Not a vendor' }); return; }

    // Find all orders that contain this vendor's products
    const orderDetails = await prisma.orderDetail.findMany({
      where: { product: { vendorId: vendor.id } },
      include: {
        order: { include: { user: { select: { name: true, mobileNumber: true } } } },
        product: true,
      },
      orderBy: { order: { orderDate: 'desc' } },
    });

    // Group by order
    const ordersMap = new Map<string, any>();
    for (const detail of orderDetails) {
      if (!ordersMap.has(detail.orderId)) {
        ordersMap.set(detail.orderId, {
          id: detail.order.id,
          status: detail.order.status,
          orderDate: detail.order.orderDate,
          totalAmount: detail.order.totalAmount,
          buyerName: detail.order.user?.name || 'Unknown',
          buyerPhone: detail.order.user?.mobileNumber || '',
          items: [],
        });
      }
      ordersMap.get(detail.orderId).items.push({
        productName: detail.product.name,
        quantity: detail.quantity,
        subtotal: detail.subtotal,
      });
    }

    res.status(200).json({ success: true, orders: Array.from(ordersMap.values()) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch vendor orders' });
  }
};

// Update order status
export const updateOrderStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orderId = req.params.id as string;
    const { status } = req.body; // CONFIRMED, SHIPPED, DELIVERED, CANCELLED

    const order = await prisma.order.update({
      where: { id: orderId },
      data: { status },
    });

    res.status(200).json({ success: true, order });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to update order status' });
  }
};

// Vendor dashboard stats
export const getVendorStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

    const vendor = await prisma.vendor.findUnique({ where: { userId } });
    if (!vendor) { res.status(403).json({ success: false, message: 'Not a vendor' }); return; }

    const totalProducts = await prisma.product.count({ where: { vendorId: vendor.id } });
    const lowStockProducts = await prisma.product.count({ where: { vendorId: vendor.id, stockLevel: { lt: 15 } } });
    
    // Get orders through vendor's products
    const orderDetails = await prisma.orderDetail.findMany({
      where: { product: { vendorId: vendor.id } },
      include: { order: true },
    });

    const pendingOrders = orderDetails.filter(d => d.order.status === 'PENDING').length;
    const totalRevenue = orderDetails.reduce((sum, d) => sum + d.subtotal, 0);

    res.status(200).json({
      success: true,
      stats: {
        totalProducts,
        lowStockProducts,
        pendingOrders,
        totalRevenue,
        todaySales: Math.floor(totalRevenue * 0.15), // Simulated daily
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch vendor stats' });
  }
};
