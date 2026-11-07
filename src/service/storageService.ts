import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { AppError } from '../lib/errors';

export interface UploadResult {
  /** A short-lived URL for the current response; never persist this value. */
  url: string;
  /** The durable object reference that belongs in Diagnosis.imageUrl. */
  storagePath: string;
  isRemote: boolean;
  filename: string;
}

const SIGNED_URL_TTL_SECONDS = 10 * 60;

function clean(value: string | undefined): string {
  return (value ?? '').trim().replace(/^["']|["']$/g, '');
}

function publicApiBase(): string {
  return (env.PUBLIC_API_URL ?? `http://127.0.0.1:${env.PORT}`).replace(/\/+$/, '');
}

function localName(reference: string): string {
  if (reference.startsWith('local:')) return path.basename(reference.slice('local:'.length));
  return path.basename(reference);
}

/**
 * Produces a temporary URL for a stored scan. The database keeps an object path
 * (`crop-scans/...` or `local:...`), not this URL, so a leaked API response
 * cannot be replayed forever.
 */
export async function resolveCropScanImage(imageRef: string | null | undefined): Promise<string | null> {
  const reference = (imageRef ?? '').trim();
  if (!reference) return null;

  if (reference.startsWith('local:') || reference.startsWith('/uploads/')) {
    if (env.NODE_ENV === 'production') return null;
    return `${publicApiBase()}/uploads/${localName(reference)}`;
  }

  const supabaseUrl = clean(env.SUPABASE_URL);
  const serviceKey = clean(env.SUPABASE_SERVICE_ROLE_KEY);

  let storagePath = reference;
  const publicMarker = '/storage/v1/object/public/';
  if (reference.startsWith('http')) {
    const markerIndex = reference.indexOf(publicMarker);
    if (markerIndex < 0) {
      // Unknown external URL. Do not convert an arbitrary URL into a storage
      // read; outside development the safe answer is "no image".
      return env.NODE_ENV === 'production' ? null : reference;
    }
    storagePath = reference.slice(markerIndex + publicMarker.length);
  }

  const slash = storagePath.indexOf('/');
  if (slash <= 0 || !supabaseUrl || !serviceKey) {
    return env.NODE_ENV === 'production' ? null : reference;
  }

  const bucket = storagePath.slice(0, slash);
  const objectPath = storagePath.slice(slash + 1);
  const encodedObject = objectPath.split('/').map(encodeURIComponent).join('/');

  try {
    const response = await fetch(
      `${supabaseUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodedObject}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      console.warn(`[StorageService] Signing failed (${response.status}): ${detail}`);
      return null;
    }

    const payload = (await response.json()) as {
      signedURL?: string;
      signedUrl?: string;
    };
    const signed = payload.signedURL ?? payload.signedUrl;
    if (!signed) return null;
    return signed.startsWith('http') ? signed : `${supabaseUrl}/storage/v1${signed}`;
  } catch (error) {
    console.warn(
      `[StorageService] Signing error: ${error instanceof Error ? error.message : 'unknown'}`,
    );
    return null;
  }
}

/**
 * Uploads a leaf scan to a private Supabase bucket. Production refuses to
 * silently write to a public local folder; development keeps a local fallback
 * so the app can be exercised before the service-role key is configured.
 */
export async function uploadCropScanImage(
  filePath: string,
  originalFilename: string,
  mimeType: string,
): Promise<UploadResult> {
  const ext = path.extname(originalFilename) || '.jpg';
  const cleanBase = path.basename(originalFilename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${cleanBase || 'leaf'}${ext}`;

  const supabaseUrl = clean(env.SUPABASE_URL);
  const serviceKey = clean(env.SUPABASE_SERVICE_ROLE_KEY);
  const bucket = env.SUPABASE_STORAGE_BUCKET;

  if (supabaseUrl && serviceKey && fs.existsSync(filePath)) {
    const fileBuffer = fs.readFileSync(filePath);
    const encodedOrOriginalFilename = encodeURIComponent(originalFilename || filename);
    const uploadUrl = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedOrOriginalFilename}`;
    console.log(`[StorageService] Attempting upload to: ${uploadUrl}`);
    const response = await fetch(
      uploadUrl,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': mimeType || 'image/jpeg',
          'x-upsert': 'false',
        },
        body: fileBuffer,
      },
    );
    console.log(`[StorageService] Upload response status: ${response.status}`);
    
    if (!response.ok) {
      const detail = await response.text();
      console.error(`[StorageService] Upload failed - Status: ${response.status}, Detail: ${detail}`);
      throw new Error(`Supabase upload failed (${response.status}): ${detail}`);
    }

    const storagePath = `${bucket}/${filename}`;
    console.log(`[StorageService] Upload successful. Storage path: ${storagePath}`);
    const url = await resolveCropScanImage(storagePath);
    if (!url) {
      console.error(`[StorageService] Uploaded image could not be signed`);
      throw new Error('Uploaded image could not be signed');
    }
    console.log(`[StorageService] Signed URL generated successfully`);
    return { url, storagePath, isRemote: true, filename };
  }
  
  // Only reach here if Supabase credentials are missing
  if (!supabaseUrl || !serviceKey || !fs.existsSync(filePath)) {
    if (env.NODE_ENV === 'production') {
      console.error(`[StorageService] Cannot upload in production - missing credentials or file`);
      throw new AppError(
        503,
        'storage_unavailable',
        'Image storage is not configured',
        undefined,
        'ছবি সংরক্ষণের ব্যবস্থা এখনো চালু হয়নি।',
      );
    }
    console.warn(`[StorageService] Using development storage (missing Supabase credentials)`);
  }

  if (env.NODE_ENV === 'production') {
    throw new AppError(
      503,
      'storage_unavailable',
      'Image storage is not configured',
      undefined,
      'ছবি সংরক্ষণের ব্যবস্থা এখনো চালু হয়নি।',
    );
  }

  const basename = path.basename(filePath);
  return {
    url: `${publicApiBase()}/uploads/${basename}`,
    storagePath: `local:${basename}`,
    isRemote: false,
    filename: basename,
  };
}
