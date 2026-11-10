import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { AppError } from '../lib/errors';

export interface UploadResult {
  /** A short-lived URL for the current response; never persist this value. */
  url: string | null;
  /** The durable object reference that belongs in Diagnosis.imageUrl. */
  storagePath: string;
  isRemote: boolean;
  filename: string;
}

const SIGNED_URL_TTL_SECONDS = 10 * 60;

/** Uploads must carry a real image type: the bucket rejects octet-stream. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * The client sends the photo as `application/octet-stream` (Dart's multipart
 * file carries no per-part type), which Supabase Storage rejects with a 415.
 * The bytes are authoritative, so the type is read from the file signature and
 * the client's claim is only a fallback.
 */
export function sniffImageMime(buffer: Buffer, filename: string, claimed?: string): string {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  const byExtension = MIME_BY_EXTENSION[path.extname(filename).toLowerCase()];
  if (byExtension) return byExtension;

  const normalised = (claimed ?? '').trim().toLowerCase();
  if (normalised.startsWith('image/') && normalised !== 'image/*') return normalised;

  return 'image/jpeg';
}

function extensionFor(mime: string): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

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
 * Local stand-in used when the bucket rejects an upload. Development keeps the
 * file so the app can still show it; production stores no reference rather than
 * claiming an object that is not there.
 */
export function fallbackUpload(filePath: string): UploadResult {
  const basename = path.basename(filePath);
  if (env.NODE_ENV === 'production') {
    return { url: null, storagePath: '', isRemote: false, filename: basename };
  }
  return {
    url: `${publicApiBase()}/uploads/${basename}`,
    storagePath: `local:${basename}`,
    isRemote: false,
    filename: basename,
  };
}

/**
 * Uploads a leaf scan to a private Supabase bucket.
 *
 * The object key is the generated filename, which is exactly the value stored in
 * `Diagnosis.imageUrl`; uploading under the client's original name (as this used
 * to) left every row pointing at an object that did not exist.
 */
export async function uploadCropScanImage(
  filePath: string,
  originalFilename: string,
  mimeType: string,
): Promise<UploadResult> {
  if (!fs.existsSync(filePath)) {
    throw new AppError(400, 'validation_error', 'Uploaded image is missing', undefined, 'ছবিটি পাওয়া যায়নি।');
  }

  const fileBuffer = fs.readFileSync(filePath);
  if (fileBuffer.length === 0) {
    throw new AppError(400, 'validation_error', 'Uploaded image is empty', undefined, 'ছবিটি খালি।');
  }

  const detectedMime = sniffImageMime(fileBuffer, originalFilename, mimeType);
  const ext = extensionFor(detectedMime);
  const cleanBase = path
    .basename(originalFilename, path.extname(originalFilename))
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 40);
  const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${cleanBase || 'leaf'}${ext}`;

  const supabaseUrl = clean(env.SUPABASE_URL);
  const serviceKey = clean(env.SUPABASE_SERVICE_ROLE_KEY);
  const bucket = env.SUPABASE_STORAGE_BUCKET;

  if (!supabaseUrl || !serviceKey) {
    if (env.NODE_ENV === 'production') {
      throw new AppError(
        503,
        'storage_unavailable',
        'Image storage is not configured',
        undefined,
        'ছবি সংরক্ষণের ব্যবস্থা এখনো চালু হয়নি।',
      );
    }
    console.warn('[StorageService] Using development storage (missing Supabase credentials)');
    return fallbackUpload(filePath);
  }

  const uploadUrl = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeURIComponent(filename)}`;
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': detectedMime,
      'x-upsert': 'false',
    },
    body: fileBuffer,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase upload failed (${response.status}): ${detail}`);
  }

  const storagePath = `${bucket}/${filename}`;
  // A signing failure must not lose the diagnosis: the object exists, so the
  // durable path is still worth storing and the client gets no image URL.
  const url = await resolveCropScanImage(storagePath);
  return { url, storagePath, isRemote: true, filename };
}
