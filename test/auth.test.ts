import crypto from 'crypto';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import prisma from '../src/config/db';

type Role = 'farmer' | 'vendor' | 'expert';

const createdUserIds: string[] = [];

function nextMobile(): string {
  const digits = crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
  return `019${digits}`;
}

async function registerUser(options: { role?: Role; password?: string; mobile?: string } = {}) {
  const mobile = options.mobile ?? nextMobile();
  const password = options.password ?? 'Str0ngPass!23';

  const response = await request(app)
    .post('/api/auth/register')
    .send({
      name: 'Test Farmer',
      mobile,
      password,
      role: options.role ?? 'farmer',
      district: 'Dhaka',
    });

  if (response.status === 201) createdUserIds.push(response.body.user.id);
  return { response, mobile, password };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

describe('registration', () => {
  it('registers a farmer, hashes the password and returns a usable session', async () => {
    const { response, mobile } = await registerUser();

    expect(response.status).toBe(201);
    expect(response.body.user.status).toBe('pending');
    expect(response.body.user.mobile).toBe(`+880${mobile.slice(1)}`);
    expect(response.body.access).toBeTruthy();
    expect(response.body.refresh).toBeTruthy();
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');

    const me = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${response.body.access}`);

    expect(me.status).toBe(200);
    expect(me.body.user.mobile).toBe(`+880${mobile.slice(1)}`);
    expect(me.body.user.role).toBe('farmer');
    expect(JSON.stringify(me.body)).not.toContain('passwordHash');
  });

  it('rejects a duplicate mobile number without leaking which field failed', async () => {
    const { mobile } = await registerUser();
    const second = await registerUser({ mobile });

    expect(second.response.status).toBe(409);
    expect(second.response.body.code).toBe('mobile_taken');
  });

  it('rejects an invalid mobile number, a weak password and a self-assigned admin role', async () => {
    const badMobile = await request(app).post('/api/auth/register').send({
      name: 'Test User',
      mobile: '12345',
      password: 'Str0ngPass!23',
      role: 'farmer',
      district: 'Dhaka',
    });
    expect(badMobile.status).toBe(400);
    expect(badMobile.body.code).toBe('validation_error');
    expect(badMobile.body.details[0].field).toBe('mobile');

    const shortPassword = await request(app).post('/api/auth/register').send({
      name: 'Test User',
      mobile: nextMobile(),
      password: 'short',
      role: 'farmer',
      district: 'Dhaka',
    });
    expect(shortPassword.status).toBe(400);
    expect(shortPassword.body.details[0].field).toBe('password');

    const adminRole = await request(app).post('/api/auth/register').send({
      name: 'Test User',
      mobile: nextMobile(),
      password: 'Str0ngPass!23',
      role: 'admin',
      district: 'Dhaka',
    });
    expect(adminRole.status).toBe(400);
  });

  it('rejects a password that contains the mobile number', async () => {
    const mobile = nextMobile();
    const response = await request(app).post('/api/auth/register').send({
      name: 'Test User',
      mobile,
      password: `x${mobile}y`,
      role: 'farmer',
      district: 'Dhaka',
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('mobile number');
  });
});

describe('login', () => {
  it('signs in with the right password and rejects the wrong one with the same answer as an unknown number', async () => {
    const { mobile, password } = await registerUser();

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ mobile, password: 'WrongPass!23' });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.code).toBe('invalid_credentials');

    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ mobile: nextMobile(), password: 'WrongPass!23' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('invalid_credentials');
    expect(unknown.body.message).toBe(wrongPassword.body.message);

    const good = await request(app)
      .post('/api/auth/login')
      .send({ mobile, password });
    expect(good.status).toBe(200);
    expect(good.body.access).toBeTruthy();
    expect(good.body.user.status).toBe('pending');
  });

  it('requires a bearer token for the profile endpoint', async () => {
    const response = await request(app).get('/api/users/me');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthenticated');
  });

  it('rejects a forged token', async () => {
    const response = await request(app)
      .get('/api/users/me')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(response.status).toBe(401);
  });

  it('locks an account after five failed attempts, even if the next password is correct', async () => {
    const { response, mobile, password } = await registerUser();
    const userId = response.body.user.id;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await request(app)
        .post('/api/auth/login')
        .send({ mobile, password: 'WrongPass!23' });
      expect(failed.status).toBe(401);
    }

    const whileLocked = await request(app)
      .post('/api/auth/login')
      .send({ mobile, password });
    expect(whileLocked.status).toBe(401);

    await prisma.user.update({
      where: { id: userId },
      data: { lockedUntil: null, failedLoginAttempts: 0 },
    });

    const afterUnlock = await request(app)
      .post('/api/auth/login')
      .send({ mobile, password });
    expect(afterUnlock.status).toBe(200);
  });
});

describe('approval gate', () => {
  it('lets a pending vendor sign in but blocks vendor operations', async () => {
    const { response, mobile, password } = await registerUser({ role: 'vendor' });

    expect(response.status).toBe(201);
    expect(response.body.user.status).toBe('pending');
    expect(response.body.user.vendor.verification_status).toBe('pending');

    const session = await request(app)
      .post('/api/auth/login')
      .send({ mobile, password });
    expect(session.status).toBe(200);

    const profile = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${session.body.access}`);
    expect(profile.status).toBe(200);

    const vendorRoute = await request(app)
      .get('/api/vendor/products')
      .set('Authorization', `Bearer ${session.body.access}`);
    expect(vendorRoute.status).toBe(403);
    expect(vendorRoute.body.code).toBe('account_pending');
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and revokes every session when a rotated token is replayed', async () => {
    const { response } = await registerUser();
    const firstRefresh = response.body.refresh;

    const rotated = await request(app).post('/api/auth/refresh').send({ refresh: firstRefresh });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh).not.toBe(firstRefresh);

    const replay = await request(app).post('/api/auth/refresh').send({ refresh: firstRefresh });
    expect(replay.status).toBe(401);

    const afterReplay = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh: rotated.body.refresh });
    expect(afterReplay.status).toBe(401);

    const accessAfterReplay = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${rotated.body.access}`);
    expect(accessAfterReplay.status).toBe(401);
  });

  it('revokes the refresh token on logout', async () => {
    const { response } = await registerUser();
    const refresh = response.body.refresh;

    const logout = await request(app).post('/api/auth/logout').send({ refresh });
    expect(logout.status).toBe(204);

    const reuse = await request(app).post('/api/auth/refresh').send({ refresh });
    expect(reuse.status).toBe(401);
  });

  it('signs out every device when the password changes', async () => {
    const { response, mobile, password } = await registerUser();
    const oldAccess = response.body.access;
    const oldRefresh = response.body.refresh;

    const changed = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${oldAccess}`)
      .send({ currentPassword: password, newPassword: 'An0therPass!45' });
    expect(changed.status).toBe(200);
    expect(changed.body.access).toBeTruthy();

    const staleAccess = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${oldAccess}`);
    expect(staleAccess.status).toBe(401);

    const staleRefresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh: oldRefresh });
    expect(staleRefresh.status).toBe(401);

    const oldPassword = await request(app)
      .post('/api/auth/login')
      .send({ mobile, password });
    expect(oldPassword.status).toBe(401);

    const newPassword = await request(app)
      .post('/api/auth/login')
      .send({ mobile, password: 'An0therPass!45' });
    expect(newPassword.status).toBe(200);
  });
});

describe('password reset', () => {
  it('issues a dev-only token, resets the password and invalidates old sessions', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      const { response, mobile } = await registerUser();
      const oldRefresh = response.body.refresh;

      const forgot = await request(app)
        .post('/api/auth/password/forgot')
        .send({ mobile });
      expect(forgot.status).toBe(200);

      const logLine = info.mock.calls
        .map((call) => call.join(' '))
        .find((line) => line.includes(mobile));
      expect(logLine).toBeTruthy();

      const token = logLine?.split(': ').pop();
      expect(token).toBeTruthy();

      const reset = await request(app)
        .post('/api/auth/password/reset')
        .send({ token, newPassword: 'Res3tPass!67' });
      expect(reset.status).toBe(200);

      const oldRefreshResult = await request(app)
        .post('/api/auth/refresh')
        .send({ refresh: oldRefresh });
      expect(oldRefreshResult.status).toBe(401);

      const oldPassword = await request(app)
        .post('/api/auth/login')
        .send({ mobile, password: 'Str0ngPass!23' });
      expect(oldPassword.status).toBe(401);

      const newPassword = await request(app)
        .post('/api/auth/login')
        .send({ mobile, password: 'Res3tPass!67' });
      expect(newPassword.status).toBe(200);

      const reused = await request(app)
        .post('/api/auth/password/reset')
        .send({ token, newPassword: 'Ag4inPass!89' });
      expect(reused.status).toBe(400);
      expect(reused.body.code).toBe('invalid_reset_token');
    } finally {
      info.mockRestore();
    }
  });

  it('answers identically for an unknown number', async () => {
    const response = await request(app)
      .post('/api/auth/password/forgot')
      .send({ mobile: nextMobile() });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});

describe('account isolation', () => {
  it('returns only the caller’s own account', async () => {
    const first = await registerUser();
    const second = await registerUser();

    const firstMe = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${first.response.body.access}`);
    const secondMe = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${second.response.body.access}`);

    expect(firstMe.body.user.mobile).toBe(`+880${first.mobile.slice(1)}`);
    expect(secondMe.body.user.mobile).toBe(`+880${second.mobile.slice(1)}`);
    expect(firstMe.body.user.id).not.toBe(secondMe.body.user.id);
  });
});
