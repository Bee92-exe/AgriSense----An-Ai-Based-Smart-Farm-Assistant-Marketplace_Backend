import crypto from 'crypto';
import request from 'supertest';
import { Role, UserStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import prisma from '../src/config/db';
import { hashPassword } from '../src/lib/password';
import { normalizeMobile } from '../src/lib/phone';

const PASSWORD = 'Exp3rtTest!23';
const createdUserIds: string[] = [];
let diagnosisId = '';
let expertToken = '';
let farmerToken = '';

function nextMobile(): string {
  const digits = crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
  return `017${digits}`;
}

async function createAccount(role: Role) {
  const mobile = normalizeMobile(nextMobile());
  if (!mobile) throw new Error('Test mobile number is invalid');
  const user = await prisma.user.create({
    data: {
      name: `${role} Queue Test`,
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
  const expert = await createAccount(Role.EXPERT);
  const farmer = await createAccount(Role.FARMER);
  expertToken = await login(expert.mobileNumber);
  farmerToken = await login(farmer.mobileNumber);

  const diagnosis = await prisma.diagnosis.create({
    data: {
      imageUrl: 'local:queue-test.jpg',
      aiDetectedDisease: 'অনিশ্চিত রোগ',
      confidenceScore: 0.4,
      treatmentSteps: JSON.stringify({
        crop_en: 'Rice',
        ai_disease_name: 'অনিশ্চিত রোগ',
        is_grounded_rag: false,
        review_reason: 'low_confidence',
        steps: [],
      }),
      status: 'PENDING_REVIEW',
      userId: farmer.id,
    },
    select: { id: true },
  });
  diagnosisId = diagnosis.id;
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

describe('expert low-confidence queue', () => {
  it('is role-gated and lists a pending diagnosis for an approved expert', async () => {
    const asFarmer = await request(app)
      .get('/api/expert/diagnoses/pending')
      .set('Authorization', `Bearer ${farmerToken}`);
    expect(asFarmer.status).toBe(403);

    const pending = await request(app)
      .get('/api/expert/diagnoses/pending')
      .set('Authorization', `Bearer ${expertToken}`);

    expect(pending.status).toBe(200);
    const item = pending.body.diagnoses.find(
      (entry: { id: string }) => entry.id === diagnosisId,
    );
    expect(item).toBeTruthy();
    expect(item.confidence).toBeCloseTo(0.4);
  });

  it('lets an expert confirm the disease and makes the farmer result final', async () => {
    const reviewed = await request(app)
      .put(`/api/expert/diagnoses/${diagnosisId}/review`)
      .set('Authorization', `Bearer ${expertToken}`)
      .send({ review: 'লক্ষণ অনুযায়ী এটি নিশ্চিত।', diseaseName: 'ধানের ব্লাস্ট' });

    expect(reviewed.status).toBe(200);
    expect(reviewed.body.diagnosis.status).toBe('completed');

    const detail = await request(app)
      .get(`/api/diagnosis/${diagnosisId}`)
      .set('Authorization', `Bearer ${farmerToken}`);

    expect(detail.status).toBe(200);
    expect(detail.body.data.show_as_final).toBe(true);
    expect(detail.body.data.reviewed_by_expert).toBe(true);
    expect(detail.body.data.disease.name_bn).toBe('ধানের ব্লাস্ট');
  });
});
