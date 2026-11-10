import crypto from 'crypto';
import request from 'supertest';
import { Role, UserStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import prisma from '../src/config/db';
import { hashPassword } from '../src/lib/password';
import { normalizeMobile } from '../src/lib/phone';

const PASSWORD = 'St4ffDeskTest!23';
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdProductIds: string[] = [];
const createdOrderIds: string[] = [];
const createdNewsIds: string[] = [];
const createdArticleIds: string[] = [];

let vendorAToken = '';
let vendorBToken = '';
let farmerToken = '';
let expertToken = '';
let productAId = '';
let orderAId = '';

function nextMobile(): string {
  const digits = crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
  return `017${digits}`;
}

async function createAccount(role: Role) {
  const mobile = normalizeMobile(nextMobile());
  if (!mobile) throw new Error('Test mobile number is invalid');
  const user = await prisma.user.create({
    data: {
      name: `${role} Desk Test`,
      mobileNumber: mobile,
      passwordHash: await hashPassword(PASSWORD),
      role,
      status: UserStatus.ACTIVE,
      location: 'Dhaka',
    },
    select: { id: true, mobileNumber: true },
  });
  createdUserIds.push(user.id);

  if (role === Role.EXPERT) {
    await prisma.expert.create({
      data: {
        userId: user.id,
        specialization: 'Rice pathology',
        certification: 'BSc Agriculture',
        verified: true,
      },
    });
  } else if (role === Role.FARMER) {
    await prisma.farmer.create({ data: { userId: user.id } });
  } else if (role === Role.VENDOR) {
    const vendor = await prisma.vendor.create({
      data: {
        userId: user.id,
        shopName: `${role} Shop ${crypto.randomBytes(2).toString('hex')}`,
        verificationStatus: 'ACTIVE',
      },
      select: { id: true },
    });
    createdVendorIds.push(vendor.id);
  }

  return user;
}

async function login(mobile: string): Promise<string> {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ mobile, password: PASSWORD });
  expect(response.status).toBe(200);
  return response.body.access;
}

beforeAll(async () => {
  const vendorA = await createAccount(Role.VENDOR);
  const vendorB = await createAccount(Role.VENDOR);
  const farmer = await createAccount(Role.FARMER);
  const expert = await createAccount(Role.EXPERT);

  vendorAToken = await login(vendorA.mobileNumber);
  vendorBToken = await login(vendorB.mobileNumber);
  farmerToken = await login(farmer.mobileNumber);
  expertToken = await login(expert.mobileNumber);

  const product = await request(app)
    .post('/api/vendor/products')
    .set('Authorization', `Bearer ${vendorAToken}`)
    .send({ name: 'Test Urea', category: 'fertilizer', price: 120, stockLevel: 40 });
  expect(product.status).toBe(201);
  productAId = product.body.product.id;
  createdProductIds.push(productAId);

  const vendorAId = createdVendorIds[0];
  const order = await prisma.order.create({
    data: {
      orderNo: `AG-TEST-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      userId: farmer.id,
      vendorId: vendorAId,
      totalAmount: 240,
      paymentMethod: 'cod',
      deliveryAddress: 'Dhaka',
      status: 'PENDING',
      details: { create: [{ productId: productAId, quantity: 2, subtotal: 240 }] },
      events: { create: [{ status: 'PENDING' }] },
    },
    select: { id: true },
  });
  orderAId = order.id;
  createdOrderIds.push(orderAId);
});

afterAll(async () => {
  if (createdArticleIds.length > 0) {
    await prisma.expertArticle.deleteMany({ where: { id: { in: createdArticleIds } } });
  }
  if (createdNewsIds.length > 0) {
    await prisma.newsItem.deleteMany({ where: { id: { in: createdNewsIds } } });
  }
  if (createdOrderIds.length > 0) {
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  if (createdProductIds.length > 0) {
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  }
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

describe('vendor ownership', () => {
  it('refuses a product edit from another vendor and from a farmer', async () => {
    const asFarmer = await request(app)
      .put(`/api/vendor/products/${productAId}`)
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ price: 1 });
    expect(asFarmer.status).toBe(403);

    const asOtherVendor = await request(app)
      .put(`/api/vendor/products/${productAId}`)
      .set('Authorization', `Bearer ${vendorBToken}`)
      .send({ price: 1 });
    expect(asOtherVendor.status).toBe(404);

    const unchanged = await prisma.product.findUnique({
      where: { id: productAId },
      select: { price: true },
    });
    expect(unchanged?.price).toBe(120);
  });

  it('lets the owning vendor edit its own product', async () => {
    const response = await request(app)
      .put(`/api/vendor/products/${productAId}`)
      .set('Authorization', `Bearer ${vendorAToken}`)
      .send({ price: 150 });

    expect(response.status).toBe(200);
    expect(response.body.product.price).toBe(150);
  });

  it('refuses an order status change from another vendor and from a farmer', async () => {
    const asFarmer = await request(app)
      .put(`/api/vendor/orders/${orderAId}/status`)
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ status: 'DELIVERED' });
    expect(asFarmer.status).toBe(403);

    const asOtherVendor = await request(app)
      .put(`/api/vendor/orders/${orderAId}/status`)
      .set('Authorization', `Bearer ${vendorBToken}`)
      .send({ status: 'DELIVERED' });
    expect(asOtherVendor.status).toBe(404);

    const order = await prisma.order.findUnique({
      where: { id: orderAId },
      select: { status: true },
    });
    expect(order?.status).toBe('PENDING');
  });

  it('rejects an invalid transition and records a valid one', async () => {
    const skip = await request(app)
      .put(`/api/vendor/orders/${orderAId}/status`)
      .set('Authorization', `Bearer ${vendorAToken}`)
      .send({ status: 'DELIVERED' });
    expect(skip.status).toBe(409);

    const confirmed = await request(app)
      .put(`/api/vendor/orders/${orderAId}/status`)
      .set('Authorization', `Bearer ${vendorAToken}`)
      .send({ status: 'CONFIRMED' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.order.order.status).toBe('confirmed');
  });

  it('builds the business view from real orders', async () => {
    const response = await request(app)
      .get('/api/vendor/business')
      .set('Authorization', `Bearer ${vendorAToken}`);

    expect(response.status).toBe(200);
    expect(response.body.business.revenue30).toBe(240);
    expect(response.body.business.customers).toHaveLength(1);
    expect(response.body.business.top_products[0].name).toBe('Test Urea');
  });
});

describe('expert news review', () => {
  it('creates a draft, publishes it, and only then reaches the farmer feed', async () => {
    const draft = await request(app)
      .post('/api/expert/news')
      .set('Authorization', `Bearer ${expertToken}`)
      .send({
        title_bn: 'পরীক্ষামূলক সংবাদ শিরোনাম',
        summary_bn: 'এটি একটি পরীক্ষামূলক সারসংক্ষেপ যা যাচাইয়ের জন্য তৈরি করা হয়েছে।',
        crop: 'rice',
      });

    expect(draft.status).toBe(201);
    expect(draft.body.draft.status).toBe('draft');
    const draftId = draft.body.draft.id;
    createdNewsIds.push(draftId);

    const hiddenFromFarmer = await request(app)
      .get('/api/news')
      .set('Authorization', `Bearer ${farmerToken}`);
    expect(
      hiddenFromFarmer.body.items.find((item: { id: string }) => item.id === draftId),
    ).toBeUndefined();

    const asFarmer = await request(app)
      .post(`/api/expert/news/${draftId}/approve`)
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ urgent: false });
    expect(asFarmer.status).toBe(403);

    const approved = await request(app)
      .post(`/api/expert/news/${draftId}/approve`)
      .set('Authorization', `Bearer ${expertToken}`)
      .send({ urgent: true });
    expect(approved.status).toBe(200);
    expect(approved.body.draft.status).toBe('published');

    const visible = await request(app)
      .get('/api/news')
      .set('Authorization', `Bearer ${farmerToken}`);
    expect(
      visible.body.items.find((item: { id: string }) => item.id === draftId),
    ).toBeTruthy();
  });
});

describe('expert articles', () => {
  it('publishes an article the farmer can read, like, rate and comment on', async () => {
    const published = await request(app)
      .post('/api/expert/articles')
      .set('Authorization', `Bearer ${expertToken}`)
      .send({
        title: 'ধানের ব্লাস্ট প্রতিরোধ',
        summary: 'প্রাথমিক লক্ষণ দেখে দ্রুত ব্যবস্থা নিন।',
        body: 'ব্লাস্ট রোগে পাতায় হীরার আকৃতির দাগ দেখা যায়। আক্রান্ত পাতা সরিয়ে ফেলুন এবং অনুমোদিত ছত্রাকনাশক ব্যবহার করুন।',
        crop: 'rice',
      });

    expect(published.status).toBe(201);
    const articleId = published.body.article.id;
    createdArticleIds.push(articleId);

    const feed = await request(app)
      .get('/api/articles')
      .set('Authorization', `Bearer ${farmerToken}`);
    expect(feed.status).toBe(200);
    expect(
      feed.body.articles.find((item: { id: string }) => item.id === articleId),
    ).toBeTruthy();

    const liked = await request(app)
      .post(`/api/articles/${articleId}/like`)
      .set('Authorization', `Bearer ${farmerToken}`);
    expect(liked.status).toBe(200);
    expect(liked.body.article.liked).toBe(true);
    expect(liked.body.article.likes).toBe(1);

    const rated = await request(app)
      .post(`/api/articles/${articleId}/rating`)
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ rating: 5 });
    expect(rated.status).toBe(200);
    expect(rated.body.article.rating).toBe(5);

    const commented = await request(app)
      .post(`/api/articles/${articleId}/comments`)
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ body: 'খুব সহায়ক লেখা।' });
    expect(commented.status).toBe(201);
    expect(commented.body.article.comments).toHaveLength(1);
  });

  it('keeps the knowledge base behind the expert role', async () => {
    const asFarmer = await request(app)
      .get('/api/expert/knowledge')
      .set('Authorization', `Bearer ${farmerToken}`);
    expect(asFarmer.status).toBe(403);

    const asExpert = await request(app)
      .get('/api/expert/knowledge')
      .set('Authorization', `Bearer ${expertToken}`);
    expect(asExpert.status).toBe(200);
    expect(Array.isArray(asExpert.body.entries)).toBe(true);
  });
});

describe('farmer questions', () => {
  it('lands in the expert queue and can be answered', async () => {
    const asked = await request(app)
      .post('/api/questions')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({
        question: 'আমার ধান গাছের পাতা হলুদ হয়ে যাচ্ছে, কী করব?',
        crop: 'rice',
        urgent: true,
      });

    expect(asked.status).toBe(201);
    expect(asked.body.question.answered).toBe(false);

    const queue = await request(app)
      .get('/api/expert/questions')
      .set('Authorization', `Bearer ${expertToken}`);
    const found = queue.body.questions.find(
      (item: { id: string }) => item.id === asked.body.question.id,
    );
    expect(found).toBeTruthy();

    const answered = await request(app)
      .post(`/api/expert/questions/${asked.body.question.id}/answer`)
      .set('Authorization', `Bearer ${expertToken}`)
      .send({ reply: 'সম্ভবত নাইট্রোজেনের অভাব। ইউরিয়া প্রয়োগ করুন।' });

    expect(answered.status).toBe(200);
    expect(answered.body.question.answered).toBe(true);

    await prisma.expertQuestion.deleteMany({
      where: { id: asked.body.question.id },
    });
  });
});
