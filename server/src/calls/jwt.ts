import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * JWT HS256 minimal, exact cât folosește LiveKit: tokenuri de acces pentru participanți,
 * tokenuri de administrare pentru API-ul serverului media și verificarea webhook-urilor.
 */
const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** Verifică semnătura și valabilitatea în timp. Întoarce conținutul sau null. */
export function verifyJwt(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: string };
    if (h.alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
    if (typeof payload.exp === 'number' && payload.exp < nowSec) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface VideoGrant {
  room?: string;
  roomJoin?: boolean;
  roomAdmin?: boolean;
  roomList?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canUpdateOwnMetadata?: boolean;
}

export function accessToken(opts: {
  apiKey: string;
  apiSecret: string;
  identity?: string;
  name?: string;
  metadata?: string;
  ttlSec: number;
  grant: VideoGrant;
  nowSec?: number;
}): string {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { iss: opts.apiKey, nbf: now - 5, exp: now + opts.ttlSec, video: opts.grant };
  if (opts.identity) payload.sub = opts.identity;
  if (opts.name) payload.name = opts.name;
  if (opts.metadata) payload.metadata = opts.metadata;
  return signJwt(payload, opts.apiSecret);
}

/**
 * Webhook-urile LiveKit poartă în antetul Authorization un JWT semnat cu cheia secretă,
 * care conține amprenta SHA-256 (base64) a corpului. Fără o semnătură validă, cererea e respinsă.
 */
export function verifyWebhook(body: Buffer, authorization: string | undefined, apiKey: string, apiSecret: string): boolean {
  if (!authorization) return false;
  const token = authorization.replace(/^Bearer\s+/i, '');
  const claims = verifyJwt(token, apiSecret);
  if (!claims || claims.iss !== apiKey || typeof claims.sha256 !== 'string') return false;
  const digest = createHash('sha256').update(body).digest();
  const claimed = Buffer.from(claims.sha256, 'base64');
  return claimed.length === digest.length && timingSafeEqual(claimed, digest);
}
