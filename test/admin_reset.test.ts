import crypto from 'crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import prisma from '../src/config/db';

/**
 * The password-reset flow now fails closed, so an administrator reissuing a
 * temporary password is the only recovery path. These tests pin the three things
 * that make it safe: it works, it revokes the old credential and session, and it
 * cannot be aimed at the acting admin or reached by a non-admin.
 */

const createdUserIds: string[] = [];

function nextMobile(): string {
  const digits = crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
  return `013${digits}`;
}

async function createActiveUser(role: 'FARMER' | 'ADMIN', password: string) {
  const mobile = nextMobile();
  const registered = await request(app).post('/api/auth/register').send({
    name: 'Reset Test',
    mobile,
    password,
    role: 'farmer',
    district: 'ঢাকা',
  });
  expect(registered.status).toBe(201);

  const id = registered.body.user.id as string;
  createdUserIds.push(id);

  // Registration cannot create an admin; the same write that provisioning uses
  // is applied here, then a fresh token is issued so the role claim is correct.
  await prisma.user.update({
    where: { id },
    data: { status: 'ACTIVE', role },
  });

  const login = await request(app).post('/api/auth/login').send({ mobile, password });
  expect(login.status).toBe(200);

  return {
    id,
    mobile,
    access: login.body.access as string,
    refresh: login.body.refresh as string,
  };
}

afterAll(async () => {
  await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: createdUserIds } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe('admin password reissue', () => {
  it('issues a temporary password, revokes the old one and is audited', async () => {
    const admin = await createActiveUser('ADMIN', 'Adm1nPass!234');
    const farmer = await createActiveUser('FARMER', 'Farm3rPass!234');

    const reset = await request(app)
      .post(`/api/admin/users/${farmer.id}/reset-password`)
      .set('Authorization', `Bearer ${admin.access}`)
      .send({ reason: 'test recovery' });

    expect(reset.status).toBe(200);
    const temporary = reset.body.temporary_password as string;
    expect(temporary.length).toBeGreaterThanOrEqual(12);

    const oldPassword = await request(app)
      .post('/api/auth/login')
      .send({ mobile: farmer.mobile, password: 'Farm3rPass!234' });
    expect(oldPassword.status).toBe(401);

    const withTemporary = await request(app)
      .post('/api/auth/login')
      .send({ mobile: farmer.mobile, password: temporary });
    expect(withTemporary.status).toBe(200);

    const oldRefresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh: farmer.refresh });
    expect(oldRefresh.status).toBe(401);

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: 'user.reset_password', targetId: farmer.id },
      select: { message: true },
    });
    expect(audit?.message).toContain('reset the password of');
  });

  it('refuses to reissue the acting admin’s own password', async () => {
    const admin = await createActiveUser('ADMIN', 'Adm1nPass!234');

    const self = await request(app)
      .post(`/api/admin/users/${admin.id}/reset-password`)
      .set('Authorization', `Bearer ${admin.access}`)
      .send({});

    expect(self.status).toBe(400);
    expect(self.body.code).toBe('cannot_modify_self');
  });

  it('is not reachable by a farmer', async () => {
    const farmer = await createActiveUser('FARMER', 'Farm3rPass!234');
    const victim = await createActiveUser('FARMER', 'Farm3rPass!234');

    const forbidden = await request(app)
      .post(`/api/admin/users/${victim.id}/reset-password`)
      .set('Authorization', `Bearer ${farmer.access}`)
      .send({});

    expect(forbidden.status).toBe(403);
  });
});
