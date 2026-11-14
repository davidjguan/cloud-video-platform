/**
 * Pure helpers (no AWS calls), kept separate so they're easy to unit test.
 */

export interface JsonResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function json(statusCode: number, body: unknown): JsonResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

/** Parses a JSON request body (API Gateway may base64-encode it). */
export function parseBody(body: string | undefined, isBase64Encoded?: boolean): Record<string, unknown> {
  if (!body) return {};
  const text = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
}

/** Only allow keys inside videos/ ending in .mp4, with no path tricks. */
export function isValidVideoKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length <= 300 &&
    /^videos\/[A-Za-z0-9 _.\-]+\.mp4$/i.test(key) &&
    !key.includes('..')
  );
}

export function requireVideoKey(key: unknown): string {
  if (!isValidVideoKey(key)) throw new HttpError(400, 'Invalid video key');
  return key;
}

/** "videos/ocean-waves.mp4" -> "Ocean Waves" */
export function titleFromKey(key: string): string {
  const name = key.split('/').pop()!.replace(/\.mp4$/i, '');
  return name
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "My Beach Trip!" -> "my-beach-trip" (safe for an S3 key) */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'video';
}

/** Trimmed, length-checked text field. */
export function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} is required`);
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) throw new HttpError(400, `${field} is required`);
  if (text.length > maxLength) throw new HttpError(400, `${field} must be at most ${maxLength} characters`);
  return text;
}

/** Clamp a playback position to a sane whole number of seconds. */
export function toSeconds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'seconds must be a non-negative number');
  return Math.min(Math.floor(n), 24 * 60 * 60);
}

/**
 * Cognito puts the user's groups in the "cognito:groups" claim. Through an HTTP API JWT
 * authorizer an array claim arrives as a string like "[admins editors]".
 */
export function parseGroups(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (typeof claim !== 'string' || !claim.trim()) return [];
  return claim.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
}

/** Public display name: the part of the email before the @. */
export function displayName(email: string): string {
  return (email.split('@')[0] || 'user').slice(0, 40);
}

/** Sortable unique id for comments: time first, so a query returns them in order. */
export function newCommentId(now = Date.now()): string {
  return `${now.toString().padStart(15, '0')}#${Math.random().toString(36).slice(2, 10)}`;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
