import crypto from 'crypto';
import request from 'supertest';
import { Role, UserStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import prisma from '../src/config/db';
import { hashPassword } from '../src/lib/password';
import { normalizeMobile } from '../src/lib/phone';

const PASSWORD = 'Adm1nTest!2345';
const createdUserIds: string[] = [];
let adminId = '';
let adminToken = '';
let farmerToken = '';

function nextMobile(): string {
  const digits = crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
  return `018${digits}`;
}

async function createAccount(
  role: Role,
  status: UserStatus,
  options: { shopName?: string; specialization?: string } = {},
) {
  const mobile = normalizeMobile(nextMobile());
  if (!mobile) throw new Error('Test mobile number is invalid');
  const passwordHash = await hashPassword(PASSWORD);

  const user = await prisma.user.create({
    data: {
      name: `${role} Test`,
      mobileNumber: mobile,
      passwordHash,
      role,
      status,
      location: 'Dhaka',
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);

  if (role === Role.VENDOR) {
    await prisma.vendor.create({
      data: {
        userId: user.id,
        shopName: options.shopName ?? 'Test Shop',
        verificationStatus: 'PENDING',
      },
    });
  } else if (role === Role.EXPERT) {
    await prisma.expert.create({
      data: {
        userId: user.id,
        specialization: options.specialization ?? 'Rice',
        verified: false,
      },
    });
  } else if (role === Role.FARMER) {
    await prisma.farmer.create({ data: { userId: user.id } });
  }

  return { id: user.id, mobile };
}

async function login(mobile: string): Promise<string> {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ mobile, password: PASSWORD });
  expect(response.status).toBe(200);
  return response.body.access;
}

beforeAll(async () => {
  const admin = await createAccount(Role.ADMIN, UserStatus.ACTIVE);
  adminId = admin.id;
  adminToken = await login(admin.mobile);

  const farmer = await createAccount(Role.FARMER, UserStatus.ACTIVE);
  farmerToken = await login(farmer.mobile);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await prisma.adminAuditLog.deleteMany({
      where: {
        OR: [
          { actorId: { in: createdUserIds } },
          { targetId: { in: createdUserIds } },
        ],
      },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

describe('admin authorisation', () => {
  it('rejects anonymous and non-admin callers', async () => {
    const anonymous = await request(app).get('/api/admin/vendors');
    expect(anonymous.status).toBe(401);

    const farmer = await request(app)
      .get('/api/admin/vendors')
      .set('Authorization', `Bearer ${farmerToken}`);
    expect(farmer.status).toBe(403);
    expect(farmer.body.code).toBe('forbidden');
  });
});

describe('vendor approvals', () => {
  it('lists a pending vendor, approves it, and lets its existing session operate', async () => {
    const vendor = await createAccount(Role.VENDOR, UserStatus.PENDING, {
      shopName: 'Approved Store',
    });
    const vendorToken = await login(vendor.mobile);

    const pending = await request(app)
      .get('/api/admin/vendors?status=pending')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(pending.status).toBe(200);
    const application = pending.body.vendors.find(
      (item: { owner_mobile: string }) => item.owner_mobile === vendor.mobile,
    );
    expect(application).toBeTruthy();
    expect(application.shop_name).toBe('Approved Store');

    const approved = await request(app)
      .post(`/api/admin/vendors/${application.id}/verify`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(approved.status).toBe(200);
    expect(approved.body.vendor.status).toBe('verified');

    const account = await prisma.user.findUnique({ where: { id: vendor.id } });
    expect(account?.status).toBe(UserStatus.ACTIVE);

    const vendorRoute = await request(app)
      .get('/api/vendor/products')
      .set('Authorization', `Bearer ${vendorToken}`);
    expect(vendorRoute.status).toBe(200);
  });

  it('rejects a vendor with a reason and removes its account', async () => {
    const vendor = await createAccount(Role.VENDOR, UserStatus.PENDING, {
      shopName: 'Rejected Store',
    });

    const pending = await request(app)
      .get('/api/admin/vendors?status=pending')
      .set('Authorization', `Bearer ${adminToken}`);
    const application = pending.body.vendors.find(
      (item: { owner_mobile: string }) => item.owner_mobile === vendor.mobile,
    );
    expect(application).toBeTruthy();

    const rejected = await request(app)
      .post(`/api/admin/vendors/${application.id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Trade licence could not be read' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.vendor.status).toBe('rejected');
    expect(rejected.body.vendor.reason).toBe('Trade licence could not be read');

    const account = await prisma.user.findUnique({ where: { id: vendor.id } });
    expect(account?.status).toBe(UserStatus.REMOVED);

    const blocked = await request(app)
      .post('/api/auth/login')
      .send({ mobile: vendor.mobile, password: PASSWORD });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('account_removed');
  });

  it('suspends a vendor and invalidates its session', async () => {
    const vendor = await createAccount(Role.VENDOR, UserStatus.PENDING, {
      shopName: 'Suspended Store',
    });

    const pending = await request(app)
      .get('/api/admin/vendors?status=pending')
      .set('Authorization', `Bearer ${adminToken}`);
    const application = pending.body.vendors.find(
      (item: { owner_mobile: string }) => item.owner_mobile === vendor.mobile,
    );
    expect(application).toBeTruthy();

    const suspended = await request(app)
      .post(`/api/admin/vendors/${application.id}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Repeated counterfeit stock' });
    expect(suspended.status).toBe(200);
    expect(suspended.body.vendor.status).toBe('suspended');

    const blocked = await request(app)
      .post('/api/auth/login')
      .send({ mobile: vendor.mobile, password: PASSWORD });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('account_suspended');
  });
});

describe('account approvals', () => {
  it('activates a pending expert and records the decision', async () => {
    const expert = await createAccount(Role.EXPERT, UserStatus.PENDING, {
      specialization: 'Potato disease',
    });

    const activated = await request(app)
      .patch(`/api/admin/users/${expert.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'active' });
    expect(activated.status).toBe(200);
    expect(activated.body.user.status).toBe('active');

    const profile = await prisma.expert.findUnique({
      where: { userId: expert.id },
    });
    expect(profile?.verified).toBe(true);

    const logs = await request(app)
      .get('/api/admin/logs?type=audit')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(logs.status).toBe(200);
    expect(
      logs.body.logs.some(
        (entry: { message: string }) =>
          entry.message.includes('EXPERT Test') && entry.message.includes('active'),
      ),
    ).toBe(true);
  });

  it('refuses to change the administrator’s own status', async () => {
    const response = await request(app)
      .patch(`/api/admin/users/${adminId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'suspended', reason: 'test' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('cannot_modify_self');
  });
});
