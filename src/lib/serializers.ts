import type { Prisma } from '@prisma/client';

/**
 * The public projection of a user. passwordHash, tokenVersion, lockout state
 * and reset bookkeeping must never be selected into a response.
 *
 * Profile rows are selected here so every auth response can carry the vendor or
 * expert details the Flutter models expect without a second query.
 */
export const publicUserSelect = {
  id: true,
  name: true,
  mobileNumber: true,
  role: true,
  status: true,
  location: true,
  createdAt: true,
  farmerProfile: {
    select: { landSize: true, cropPreferences: true, farmLocation: true },
  },
  vendorProfile: {
    select: { shopName: true, verificationStatus: true },
  },
  expertProfile: {
    select: { specialization: true, certification: true },
  },
} satisfies Prisma.UserSelect;

export type PublicUserRecord = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

function parseCropPreferences(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    // Older rows stored a comma-separated string rather than JSON.
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The wire user defined by `API_SPEC.md` §1: snake_case fields and lowercase
 * enum values, even though Prisma stores uppercase enum members.
 */
export function toPublicUser(user: PublicUserRecord) {
  return {
    id: user.id,
    name: user.name,
    mobile: user.mobileNumber,
    role: user.role.toLowerCase(),
    status: user.status.toLowerCase(),
    district: user.location ?? null,
    farm_size: user.farmerProfile?.landSize ?? null,
    crop_preferences: parseCropPreferences(user.farmerProfile?.cropPreferences),
    language: 'bn',
    high_contrast: false,
    voice_mode: false,
    ...(user.role === 'VENDOR' && user.vendorProfile
      ? {
          vendor: {
            shop_name: user.vendorProfile.shopName,
            verification_status: user.vendorProfile.verificationStatus.toLowerCase(),
          },
        }
      : {}),
    ...(user.role === 'EXPERT' && user.expertProfile
      ? {
          expert: {
            specialization: user.expertProfile.specialization,
            certification: user.expertProfile.certification,
          },
        }
      : {}),
  };
}

export const adminVendorInclude = {
  user: {
    select: { name: true, mobileNumber: true, location: true, createdAt: true },
  },
} satisfies Prisma.VendorInclude;

export type AdminVendorRecord = Prisma.VendorGetPayload<{ include: typeof adminVendorInclude }>;

/** One vendor application in the admin approval list. */
export function toAdminVendor(vendor: AdminVendorRecord, reason?: string | null) {
  return {
    id: vendor.id,
    shop_name: vendor.shopName,
    owner_name: vendor.user.name,
    owner_mobile: vendor.user.mobileNumber,
    district: vendor.user.location ?? '',
    license_no: vendor.businessLicense ?? '',
    status: vendor.verificationStatus.toLowerCase(),
    submitted_at: vendor.user.createdAt.toISOString(),
    ...(reason ? { reason } : {}),
  };
}

export const platformUserSelect = {
  id: true,
  name: true,
  mobileNumber: true,
  role: true,
  status: true,
  location: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type PlatformUserRecord = Prisma.UserGetPayload<{ select: typeof platformUserSelect }>;

/** One account in the admin user list. */
export function toPlatformUser(user: PlatformUserRecord, reason?: string | null) {
  return {
    id: user.id,
    name: user.name,
    mobile: user.mobileNumber,
    role: user.role.toLowerCase(),
    status: user.status.toLowerCase(),
    district: user.location ?? '',
    joined_at: user.createdAt.toISOString(),
    ...(reason ? { reason } : {}),
  };
}
